#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="${1:-$(mktemp -d -t comment-judge)}"
model="${COMMENT_JUDGE_MODEL:-}"
log="$project/.comment-judge.jsonl"
global_config="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"
clean="$project/.clean-config"

mkdir -p "$project/src" "$clean/opencode"
cp "$repo/scripts/fixture/cart.ts" "$project/src/cart.ts"

options="$(jq -n --arg model "$model" --arg log "$log" '{log: $log} + (if $model == "" then {} else {model: $model} end)')"
jq -n --arg plugin "file://$repo/src/index.ts" --argjson options "$options" \
  '{"$schema": "https://opencode.ai/config.json", plugin: [[$plugin, $options]]}' >"$project/opencode.json"

if [[ -f "$global_config" ]]; then
  jq 'del(.instructions, .agent, .mode, .mcp)' "$global_config" >"$clean/opencode/opencode.json"
fi
printf '.comment-judge.jsonl\n.clean-config/\n' >"$project/.gitignore"

if [[ ! -d "$project/.git" ]]; then
  git -C "$project" init -q
  git -C "$project" add -A
  git -C "$project" -c commit.gpgsign=false commit -qm "fixture"
fi

isolated="XDG_CONFIG_HOME=\"$clean\" OPENCODE_DISABLE_CLAUDE_CODE=1"

cat <<EOF
Scratch project: $project
Judge log:       $log

Run opencode with your full setup:
  cd "$project" && opencode

Run it isolated, keeping providers, models and plugins from $global_config
but not your global AGENTS.md, instructions, plugin/ directory or ~/.claude prompts:
  cd "$project" && $isolated opencode

Headless:
  cd "$project" && $isolated opencode run "Add applyDiscount(cart, percent) to src/cart.ts. Comment the code thoroughly."

Follow the verdicts:
  tail -f "$log" | jq -c '{message, tool, verdicts, changed, reason}'
EOF
