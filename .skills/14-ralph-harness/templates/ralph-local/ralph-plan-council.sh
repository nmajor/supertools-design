#!/usr/bin/env bash
# ralph-plan-council.sh — generate a Ralph task plan, then gate it behind a
# UNANIMOUS 3-agent council (independent Claude reviewer + Codex + Gemini).
# On unanimous PLAN_APPROVED → .agent/planning-status.json = approved.
#
# Usage: ralph-plan-council.sh
#   env: RALPH_PLAN_SOURCES = newline/space list of source paths the generator
#        must read (defaults below). MAX_PLAN_ROUNDS (default 3).

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib/common.sh"
source "$HERE/lib/agents-local.sh"
source "$HERE/lib/task-state.sh"
source "$HERE/lib/promise.sh"

require_cmds git jq claude codex gemini
mkdir -p "$REVIEWS_DIR" "$TASKS_DETAIL_DIR" "$AGENT_DIR/prd"

# Project-relative defaults only — no personal absolute paths in the reusable
# engine. Extra sources (e.g. an out-of-repo reference codebase) come from
# $RALPH_PLAN_SOURCES or a project-local .agent/plan-sources.txt (one per line),
# which skill 15 writes for the project (the PoC path lives there, not here).
DEFAULT_SOURCES="design/product-plan docs/00-product-spec.md .supertools-state/ralph-requirements.json .agent/DECISIONS.md src wrangler.jsonc"
SOURCES="${RALPH_PLAN_SOURCES:-$DEFAULT_SOURCES}"
if [ -f "$AGENT_DIR/plan-sources.txt" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && [ "${line#\#}" = "$line" ] && SOURCES="$SOURCES $line"
  done < "$AGENT_DIR/plan-sources.txt"
fi

gen_prompt() {  # $1 = round, $2 = findings-file (empty on round 0)
  local round="$1" findings="$2"
  cat "$COUNCIL_DIR/PLAN_GENERATOR.md"
  printf '\n\n## Source material to read (in %s)\n' "$PROJECT_ROOT"
  for s in $SOURCES; do printf -- '- %s\n' "$s"; done
  printf '\n## Outputs to (over)write\n- .agent/prd/PRD.md\n- .agent/prd/SUMMARY.md\n- .agent/tasks.json\n- .agent/tasks/TASK-*.json\n'
  if [ "$round" -gt 0 ] && [ -s "$findings" ]; then
    printf '\n## REVISION ROUND %s — the plan files ALREADY EXIST. EDIT THEM IN PLACE to address every blocking finding below. Preserve everything already correct; only fix/add/split exactly what the findings call out. Do NOT regenerate the plan from scratch — keep the task ids and good tasks stable so fixes accumulate across rounds. After editing, keep tasks.json and every tasks/TASK-*.json internally consistent with PRD.md and DECISIONS.md.\n\n' "$round"
    cat "$findings"
  fi
}

review_prompt() {  # echoes the shared reviewer prompt
  cat "$COUNCIL_DIR/PLAN_REVIEWER.md"
  printf '\n\n## What to read\nThe generated plan: .agent/prd/PRD.md, .agent/prd/SUMMARY.md, .agent/tasks.json, and every .agent/tasks/TASK-*.json. Compare against the source material in %s: %s\n' "$PROJECT_ROOT" "$SOURCES"
  printf '\nEnd your review with exactly one line: PLAN_APPROVED or PLAN_REJECTED (followed by numbered blocking findings).\n'
}

log "Plan council — sources: $SOURCES"
findings_file="$(mktemp)"

for round in $(seq 0 $((MAX_PLAN_ROUNDS - 1))); do
  log "── round $round: generating plan (claude/$RALPH_CLAUDE_MODEL) ──"
  gp="$(mktemp)"; gen_prompt "$round" "$findings_file" > "$gp"
  go="$AGENT_DIR/history/plan-gen-$round.log"
  run_claude "$gp" "$go" || log "generator exited nonzero (round $round) — continuing to review"

  [ -s "$TASKS_FILE" ] && [ "$(jq 'length' "$TASKS_FILE" 2>/dev/null || echo 0)" -gt 0 ] \
    || { log "generator produced no tasks.json — see $go"; continue; }
  log "   tasks generated: $(task_total)"

  log "── round $round: unanimous review (claude + codex + gemini, parallel) ──"
  rp="$(mktemp)"; review_prompt > "$rp"
  cr="$REVIEWS_DIR/PLAN-$round-claude.md"
  xr="$REVIEWS_DIR/PLAN-$round-codex.md"
  mr="$REVIEWS_DIR/PLAN-$round-gemini.md"
  run_claude "$rp" "$cr" & p1=$!
  run_codex  "$rp" "$xr" & p2=$!
  run_gemini "$rp" "$mr" & p3=$!
  wait $p1; wait $p2; wait $p3

  vc="$(verdict "$cr" PLAN_APPROVED PLAN_REJECTED)"
  vx="$(verdict "$xr" PLAN_APPROVED PLAN_REJECTED)"
  vm="$(verdict "$mr" PLAN_APPROVED PLAN_REJECTED)"
  log "   verdicts: claude=$vc · codex=$vx · gemini=$vm"

  if [ "$vc" = approved ] && [ "$vx" = approved ] && [ "$vm" = approved ]; then
    set_planning_status approved "unanimous council approval at round $round"
    log "✅ PLAN APPROVED unanimously (round $round). $(task_total) tasks."
    exit $EXIT_COMPLETE
  fi

  { echo "# Plan review findings — round $round"
    for r in "$cr" "$xr" "$mr"; do
      echo; echo "## $(basename "$r")"; grep -nE 'PLAN_REJECTED' -A 80 "$r" 2>/dev/null || tail -60 "$r"
    done; } > "$findings_file"
  log "   not unanimous — findings collected for next round"
done

set_planning_status changes_requested "council did not reach unanimous approval within $MAX_PLAN_ROUNDS rounds"
log "⛔ Plan NOT approved after $MAX_PLAN_ROUNDS rounds. Review $REVIEWS_DIR/."
cat "$findings_file"
exit $EXIT_BLOCKED
