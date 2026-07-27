#!/usr/bin/env bash
# agents-local.sh — de-dockerized agent invocation. Replaces upstream ralph's
# `sbx run <agent> .` with direct local CLI calls. Each function takes a prompt
# FILE and an output FILE, runs the agent natively in $PROJECT_ROOT with full
# (bypass/yolo) permissions, captures combined output, and returns the agent's
# exit code. Prompts go via stdin to avoid argv length limits.
#
# Safety note: upstream relied on the Docker sandbox to contain bypass-perms
# runs. Natively we substitute: a dedicated git branch + per-task commit +
# the council review gate before each commit (see ralph-council.sh).

# Per-agent wall-clock cap. A hung agent must never block the loop forever
# (a stuck claude once hung a build for ~14h). On timeout the call returns 124
# and the loop degrades gracefully (no diff → block, or unclear verdict → fix).
RALPH_AGENT_TIMEOUT="${RALPH_AGENT_TIMEOUT:-1800}"   # 30 min

# run_claude <prompt-file> <out-file>  — implementer / generator / claude-reviewer
# Runs in $PROJECT_ROOT (like the codex/gemini reviewers) so file paths resolve.
run_claude() {
  local pf="$1" out="$2"
  ( cd "$PROJECT_ROOT" && timeout -k 15 "$RALPH_AGENT_TIMEOUT" claude -p \
      --model "$RALPH_CLAUDE_MODEL" \
      --permission-mode bypassPermissions \
      < "$pf" ) > "$out" 2>&1
  return $?
}

# run_codex <prompt-file> <out-file>  — reviewer (gpt-5.5, high reasoning)
run_codex() {
  local pf="$1" out="$2"
  timeout -k 15 "$RALPH_AGENT_TIMEOUT" codex exec \
    --cd "$PROJECT_ROOT" \
    --dangerously-bypass-approvals-and-sandbox \
    -m "$RALPH_CODEX_MODEL" \
    -c model_reasoning_effort=high \
    - < "$pf" > "$out" 2>&1
  return $?
}

# run_gemini <prompt-file> <out-file>  — reviewer (gemini-2.5-pro)
run_gemini() {
  local pf="$1" out="$2"
  # Prompt via STDIN, not argv: build-review prompts embed large diffs that
  # overflow ARG_MAX ("Argument list too long") when passed via -p. Gemini reads
  # a piped prompt from stdin in non-interactive (-y) mode.
  ( cd "$PROJECT_ROOT" && timeout -k 15 "$RALPH_AGENT_TIMEOUT" gemini -m "$RALPH_GEMINI_MODEL" -y < "$pf" ) > "$out" 2>&1
  return $?
}

# Run codex + gemini reviewers in PARALLEL, each with its own prompt file.
# Args: <codex-prompt> <codex-out> <gemini-prompt> <gemini-out>
run_reviewers_parallel() {
  run_codex  "$1" "$2" &  local cpid=$!
  run_gemini "$3" "$4" &  local gpid=$!
  wait "$cpid"; local crc=$?
  wait "$gpid"; local grc=$?
  echo "$crc $grc"
}

# Verdict parsing — find the last APPROVED/REJECTED token of a given family.
# verdict <out-file> <APPROVE_TOKEN> <REJECT_TOKEN>  -> echoes approved|rejected|unclear
# Strips ANSI escapes and forces text mode (-a): agent logs embed colorized tool
# output (npm/wrangler/vite) that otherwise makes grep treat the file as binary
# and miss the verdict. The agent's FINAL line is the authoritative verdict.
verdict() {
  local out="$1" ok="$2" no="$3"
  local line
  line="$(sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' "$out" 2>/dev/null | grep -aoE "($ok|$no)" | tail -1)"
  if   [ "$line" = "$no" ]; then echo "rejected"
  elif [ "$line" = "$ok" ]; then echo "approved"
  else echo "unclear"; fi
}
