import type { Settings } from "./types.ts";

export const DEFAULT_TIMEOUT_MS = 30_000;

const MODEL_SPEC = /^[^/\s]+\/\S+$/;

export function settings(
  options: Record<string, unknown> | undefined,
  warn: (message: string) => void,
): Settings {
  const { model, timeoutMs, log } = options ?? {};
  const resolved: Settings = { model: "", timeoutMs: DEFAULT_TIMEOUT_MS, log: "" };

  if (typeof model === "string" && MODEL_SPEC.test(model.trim())) resolved.model = model.trim();
  else if (model !== undefined)
    warn(`comment-judge: model must be "provider/model", got ${JSON.stringify(model)}; using small_model`);

  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) resolved.timeoutMs = timeoutMs;
  else if (timeoutMs !== undefined)
    warn(
      `comment-judge: timeoutMs must be a positive number of milliseconds, got ${JSON.stringify(timeoutMs)}; using ${DEFAULT_TIMEOUT_MS}`,
    );

  if (typeof log === "string" && log.trim()) resolved.log = log.trim();
  else if (log !== undefined) warn(`comment-judge: log must be a file path, got ${JSON.stringify(log)}; not writing one`);

  return resolved;
}
