import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { SYSTEM } from "../../src/judge.ts";

const REPO = resolve(import.meta.dirname, "../..");
const OPENCODE_PACKAGE = join(REPO, "node_modules", "opencode-ai");
const OPENCODE = join(OPENCODE_PACKAGE, "bin", "opencode.exe");
const RUN_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 120_000;

const FILE = "src/cart.ts";
const BEFORE = "export function lineKey(sku: string): string {\n  return sku;\n}\n";
const STORY = "  // Fix: previously ABC-1 and abc-1 made two cart lines";
const CODE = "  return sku.toLowerCase();";
const REWRITE = "SKUs compare case-insensitively.";
const EXPECTED = `export function lineKey(sku: string): string {\n  // ${REWRITE}\n${CODE}\n}\n`;

type Message = { role: string; content?: unknown };
type ChatRequest = { messages: Message[]; tools?: { function: { name: string } }[]; tool_choice?: unknown };
type Scenario = { name: string; model: string; tool: string; args: Record<string, string> };

const SCENARIOS: Scenario[] = [
  {
    name: "edit",
    model: "fake-model",
    tool: "edit",
    args: { filePath: FILE, oldString: "  return sku;", newString: `${STORY}\n${CODE}` },
  },
  {
    name: "apply_patch",
    model: "gpt-5-fake",
    tool: "apply_patch",
    args: {
      patchText: [
        "*** Begin Patch",
        `*** Update File: ${FILE}`,
        "@@ export function lineKey(sku: string): string {",
        "-  return sku;",
        `+${STORY}`,
        `+${CODE}`,
        "*** End Patch",
      ].join("\n"),
    },
  },
];

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: { text?: unknown }) => String(part?.text ?? "")).join("\n")
      : "";

const toolNames = (request: ChatRequest) => (request.tools ?? []).map((tool) => tool.function.name);

function stream(response: ServerResponse, delta: Record<string, unknown>, finish: string) {
  const chunk = (body: Record<string, unknown>, reason: string | null) =>
    `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake", choices: [{ index: 0, delta: body, finish_reason: reason }] })}\n\n`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`${chunk({ role: "assistant", ...delta }, null)}${chunk({}, finish)}data: [DONE]\n\n`);
}

const callTool = (response: ServerResponse, name: string, args: unknown) =>
  stream(response, { tool_calls: [{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");

const say = (response: ServerResponse, text: string) => stream(response, { content: text }, "stop");

async function fakeModel(scenario: Scenario) {
  const requests: ChatRequest[] = [];
  const server = createServer((incoming, response) => {
    let body = "";
    incoming.on("data", (data) => {
      body += data;
    });
    incoming.on("end", () => {
      if (!incoming.url?.endsWith("/chat/completions")) {
        response.writeHead(404).end();
        return;
      }
      const request = JSON.parse(body) as ChatRequest;
      requests.push(request);
      const system = request.messages.filter((message) => message.role === "system").map((message) => textOf(message.content));
      if (system.some((text) => text.includes(SYSTEM))) {
        if (!toolNames(request).includes("StructuredOutput")) return say(response, "no StructuredOutput tool was offered");
        return callTool(response, "StructuredOutput", {
          verdicts: [{ id: "c1", action: "rewrite", reason: "tells the story of the fix", rewrite: REWRITE }],
        });
      }
      if (!toolNames(request).includes(scenario.tool)) return say(response, "Comment judge contract");
      if (request.messages.some((message) => message.role === "tool")) return say(response, "Done.");
      return callTool(response, scenario.tool, scenario.args);
    });
  });
  await new Promise<void>((listening) => {
    server.listen(0, "127.0.0.1", listening);
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => server.close() };
}

function project(root: string, scenario: Scenario, baseURL: string): string {
  const directory = join(root, "project");
  mkdirSync(join(directory, "src"), { recursive: true });
  writeFileSync(join(directory, FILE), BEFORE);
  const model = `fake/${scenario.model}`;
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: [pathToFileURL(join(REPO, "src", "index.ts")).href],
    model,
    small_model: model,
    enabled_providers: ["fake"],
    share: "disabled",
    autoupdate: false,
    formatter: false,
    lsp: false,
    provider: {
      fake: {
        npm: "@ai-sdk/openai-compatible",
        name: "Fake",
        options: { baseURL, apiKey: "fake" },
        models: { [scenario.model]: { name: scenario.model, tool_call: true } },
      },
    },
  };
  writeFileSync(join(directory, "opencode.json"), JSON.stringify(config, null, 2));
  return directory;
}

function isolatedEnv(root: string): NodeJS.ProcessEnv {
  const home = (name: string) => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  return {
    PATH: process.env.PATH ?? "",
    HOME: home("home"),
    XDG_CONFIG_HOME: home("config"),
    XDG_DATA_HOME: home("data"),
    XDG_CACHE_HOME: home("cache"),
    XDG_STATE_HOME: home("state"),
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  };
}

function opencode(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; signal: string | null; output: string }>((done, fail) => {
    const child = spawn(OPENCODE, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: RUN_TIMEOUT_MS, killSignal: "SIGKILL" });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    child.on("error", fail);
    child.on("close", (code, signal) => done({ code, signal, output }));
  });
}

describe("against a real opencode", () => {
  it("runs the pinned opencode", { timeout: TEST_TIMEOUT_MS }, async () => {
    const root = mkdtempSync(join(tmpdir(), "comment-judge-e2e-"));
    try {
      const pinned = JSON.parse(readFileSync(join(OPENCODE_PACKAGE, "package.json"), "utf8")).version;
      const { code, output } = await opencode(["--version"], root, isolatedEnv(root));
      assert.equal(code, 0, output);
      assert.equal(output.trim(), pinned);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const scenario of SCENARIOS) {
    it(`writes the judge's rewrite through ${scenario.name} and tells the agent`, { timeout: TEST_TIMEOUT_MS }, async () => {
      const root = mkdtempSync(join(tmpdir(), "comment-judge-e2e-"));
      const model = await fakeModel(scenario);
      try {
        const directory = project(root, scenario, model.url);
        const run = await opencode(["run", "--print-logs", "Fix the SKU bug in src/cart.ts"], directory, isolatedEnv(root));
        const context = `opencode exited ${run.code ?? run.signal}\n${run.output}`;
        assert.equal(run.code, 0, context);

        const judged = model.requests.filter((request) => request.messages.some((message) => textOf(message.content).includes(SYSTEM)));
        assert.equal(judged.length, 1, context);
        assert.ok(toolNames(judged[0] as ChatRequest).includes("StructuredOutput"), context);

        assert.equal(readFileSync(join(directory, FILE), "utf8"), EXPECTED, context);

        const results = model.requests.flatMap((request) =>
          request.messages.filter((message) => message.role === "tool").map((message) => textOf(message.content)),
        );
        assert.ok(
          results.some(
            (result) => result.includes("comment-judge changed comments in this edit") && result.includes(`now "// ${REWRITE}"`),
          ),
          `tool results the agent saw:\n${results.join("\n---\n")}\n${context}`,
        );
      } finally {
        model.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
