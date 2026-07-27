#!/usr/bin/env bash
# ralph-council.sh — the build loop with a 2-reviewer gate.
# Per iteration: pick highest-priority passes:false task → Claude Opus
# implements ONLY it → Codex + Gemini review the diff (correctness + acceptance
# + INTEGRATION) → fix loop → on both-approve mark passes:true + commit on the
# ralph/build branch. Refuses to run unless planning-status is approved.
#
# Usage: ralph-council.sh [--once] [--max-iterations N] [N]

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib/common.sh"
source "$HERE/lib/agents-local.sh"
source "$HERE/lib/task-state.sh"
source "$HERE/lib/promise.sh"

require_cmds git jq claude codex gemini

MAX_ITERATIONS=200
case "${1:-}" in
  --once) MAX_ITERATIONS=1 ;;
  --max-iterations) MAX_ITERATIONS="${2:-200}" ;;
  ''|*[!0-9]*) : ;;
  *) MAX_ITERATIONS="$1" ;;
esac

[ "$(planning_status)" = approved ] || die "planning-status is '$(planning_status)', not 'approved'. Run ralph-plan-council.sh first." $EXIT_PRECONDITION
[ -s "$TASKS_FILE" ] || die "no .agent/tasks.json" $EXIT_PRECONDITION
require_git_commit_capable
ensure_build_branch
ensure_clean_baseline   # isolate per-task diffs from any pre-existing dirty state

implement_prompt() {  # $1 = task id
  cat "$AGENT_DIR/PROMPT.md"
  printf '\n\n## THIS INVOCATION: implement exactly %s\nRead its spec at %s. Read .agent/DECISIONS.md and .agent/prd/SUMMARY.md first. Do NOT commit — the loop commits after review. End with <promise>%s:DONE</promise> when implemented + locally verified, or a BLOCKED/DECIDE tag.\n' \
    "$1" "$(task_spec_path "$1")" "$1"
}

review_prompt() {  # $1 = task id, $2 = diff file
  cat "$COUNCIL_DIR/CODE_REVIEWER.md"
  printf '\n\n'
  cat "$COUNCIL_DIR/INTEGRATION_REVIEWER.md"
  printf '\n\n## Task under review: %s\nSpec: %s\n## Working-tree diff to review (staged):\n```diff\n' "$1" "$(task_spec_path "$1")"
  cat "$2"
  printf '\n```\nEnd with exactly one line: CODE_APPROVED or CODE_REJECTED (followed by numbered blocking findings, each file:line).\n'
}

fix_prompt() {  # $1 = task id, $2 = findings file
  cat "$COUNCIL_DIR/FIX_REVIEW.md"
  printf '\n\n## Task: %s\nFix ONLY the blocking findings below, then re-verify. Do NOT commit.\n\n' "$1"
  cat "$2"
}

START=$(date +%s)
for i in $(seq 1 "$MAX_ITERATIONS"); do
  if all_tasks_pass; then
    log "🎉 COMPLETE — all $(task_total) tasks pass. <promise>COMPLETE</promise>"
    exit $EXIT_COMPLETE
  fi
  reap_dev_servers   # clear any dev server a prior/timed-out agent left holding a port
  id="$(next_task_id)"
  if [ -z "$id" ]; then
    # No runnable task, yet not all passed → only blocked-incomplete tasks remain.
    # This is NOT done — surface for a human rather than falsely reporting COMPLETE.
    log "⛔ no runnable tasks but $(blocked_incomplete) blocked task(s) still unpassed ($(tasks_passed)/$(task_total) passed). <promise>BLOCKED:blocked tasks remain</promise>"
    exit $EXIT_BLOCKED
  fi
  title="$(task_field "$id" title)"
  echo; log "════ iteration $i/$MAX_ITERATIONS · $id — $title ════"

  # 1) implement
  ip="$(mktemp)"; implement_prompt "$id" > "$ip"
  io="$HISTORY_DIR/$id-implement.log"
  it=1
  while :; do
    run_claude "$ip" "$io"; irc=$?
    # A transient implementer failure (empty output — e.g. a CLI/rate-limit
    # hiccup) is not a no-op. Retry with backoff before judging the task.
    if [ ! -s "$io" ] && [ "$it" -le 2 ]; then
      log "   implementer produced no output (exit $irc) — retry $it after backoff"; sleep $((it*30)); it=$((it+1)); continue
    fi
    break
  done
  [ "$irc" -ne 0 ] && log "implementer exited nonzero ($irc) — checking what it produced"
  iout="$(cat "$io")"
  if needs_help "$iout"; then
    reason="$(extract_blocked_reason "$iout")$(extract_decide_question "$iout")"
    # Don't mark blocked — a BLOCKED/DECIDE is a human-intervention point and the
    # task should be retried after the human resolves it. Just restore the tree.
    stash_attempt "$id" "needs-help"
    log "⛔ $id raised BLOCKED/DECIDE: $reason"
    exit $EXIT_BLOCKED
  fi
  # Most tasks change files. Some (deploy/secret-sync) are OPERATIONAL — their
  # deliverables are remote side-effects (wrangler secret put, custom domains)
  # with no repo diff. Distinguish the two: no diff + a DONE promise = operational
  # (review the report); no diff + no DONE = a genuine no-op → block.
  operational=false
  git -C "$PROJECT_ROOT" add -A
  if git -C "$PROJECT_ROOT" diff --cached --quiet; then
    if echo "$iout" | grep -q "<promise>$id:DONE</promise>"; then
      operational=true
      log "   $id produced no file diff but signaled DONE — operational task; the council reviews its report + remote effects."
    else
      stash_attempt "$id" "no-diff"
      mark_task_blocked "$id"
      log "⛔ $id: implementer produced no changes and did not signal DONE — marked blocked. <promise>BLOCKED:$id no diff</promise>"
      exit $EXIT_BLOCKED
    fi
  else
    echo "$iout" | grep -q "<promise>$id:DONE</promise>" \
      || log "   note: $id DONE tag not found in implementer output — proceeding on the produced diff"
  fi

  # 2) review (Codex + Gemini, parallel) → fix loop
  approved=false
  for rr in $(seq 1 "$MAX_REVIEW_ROUNDS"); do
    git -C "$PROJECT_ROOT" add -A
    diff="$(mktemp)"
    if [ "$operational" = true ]; then
      # No code diff — review the implementer's report of the operational work it
      # performed (reviewers can independently verify via wrangler/API as needed).
      { echo "OPERATIONAL TASK — no file diff. The implementer reports it performed"
        echo "remote/side-effecting work (e.g. wrangler secret put, custom domains,"
        echo "deploy, external API config). Verify the claimed effects are real and"
        echo "complete (you may run read-only checks like 'wrangler secret list')."
        echo; echo "## Implementer report:"; cat "$io"; } > "$diff"
    else
      git -C "$PROJECT_ROOT" diff --cached --stat > "$diff"
      # Exclude noisy lockfiles from the content diff (kept in --stat); cap size.
      git -C "$PROJECT_ROOT" diff --cached -- . ':(exclude)package-lock.json' ':(exclude)*.lock' | head -c 200000 >> "$diff"
    fi
    rp="$(mktemp)"; review_prompt "$id" "$diff" > "$rp"
    xr="$REVIEWS_DIR/$id-CODE-REVIEW-$rr-codex.md"
    mr="$REVIEWS_DIR/$id-CODE-REVIEW-$rr-gemini.md"
    log "   review round $rr: codex + gemini (parallel)…"
    run_codex "$rp" "$xr" & a=$!
    run_gemini "$rp" "$mr" & b=$!
    wait $a; wait $b
    vx="$(verdict "$xr" CODE_APPROVED CODE_REJECTED)"
    vm="$(verdict "$mr" CODE_APPROVED CODE_REJECTED)"
    # A reviewer that returns NO parseable verdict (empty/errored output — e.g. a
    # transient rate-limit) is NOT a rejection. Retry it with backoff before
    # counting it, so a flaky API call can't burn fix rounds or false-block a task.
    ra=1; while [ "$vx" = unclear ] && [ "$ra" -le 2 ]; do log "   codex verdict unclear — retry $ra after backoff"; sleep $((ra*30)); run_codex "$rp" "$xr"; vx="$(verdict "$xr" CODE_APPROVED CODE_REJECTED)"; ra=$((ra+1)); done
    rb=1; while [ "$vm" = unclear ] && [ "$rb" -le 2 ]; do log "   gemini verdict unclear — retry $rb after backoff"; sleep $((rb*30)); run_gemini "$rp" "$mr"; vm="$(verdict "$mr" CODE_APPROVED CODE_REJECTED)"; rb=$((rb+1)); done
    log "   verdicts: codex=$vx · gemini=$vm"
    if [ "$vx" = approved ] && [ "$vm" = approved ]; then approved=true; break; fi
    if [ "$rr" -lt "$MAX_REVIEW_ROUNDS" ]; then
      ff="$(mktemp)"; { echo "# Findings ($id review round $rr)"; for r in "$xr" "$mr"; do echo; echo "## $(basename "$r")"; grep -nE 'CODE_REJECTED' -A 60 "$r" 2>/dev/null || tail -50 "$r"; done; } > "$ff"
      fp="$(mktemp)"; fix_prompt "$id" "$ff" > "$fp"
      log "   fixing findings (claude)…"
      run_claude "$fp" "$HISTORY_DIR/$id-fix-$rr.log" || true
    fi
  done

  if [ "$approved" != true ]; then
    # Rejected work must never persist to be swept into a later baseline commit.
    stash_attempt "$id" "rejected"
    mark_task_blocked "$id"
    log "⛔ $id failed review after $MAX_REVIEW_ROUNDS rounds — rejected diff stashed, marked blocked. <promise>BLOCKED:$id review</promise>"
    exit $EXIT_BLOCKED
  fi

  # 3) accept: mark + log, then COMMIT (must succeed for code tasks). Operational
  #    tasks have nothing to commit — they're finalized on council approval + their
  #    verified remote effects.
  mark_task_pass "$id"
  log_entry "$id — $title" "Council-approved (codex+gemini)$([ "$operational" = true ] && echo ' [operational — no diff]'). Review: $REVIEWS_DIR/$id-CODE-REVIEW-*."
  if [ "$operational" = true ]; then
    log "   ✓ $id done (operational, no commit) ($(task_remaining) remaining)"
  elif ! commit_task "$id" "$title"; then
    stash_attempt "$id" "commit-fail"
    mark_task_blocked "$id"
    log "⛔ $id: commit failed — restored tree, marked blocked. <promise>BLOCKED:$id commit</promise>"
    exit $EXIT_BLOCKED
  else
    log "   ✓ $id done & committed ($(task_remaining) remaining)"
  fi
done

log "⚠️ reached max iterations ($MAX_ITERATIONS); $(task_remaining) tasks remain."
exit $EXIT_MAX_ITERATIONS
