#!/usr/bin/env bash
# common.sh — shared paths, config, logging, planning-status + git helpers for
# the de-dockerized ralph council engine. Sourced by both drivers.
# Dependencies: git, jq.

set -uo pipefail

# Resolve project root: this lib lives at <root>/scripts/ralph-local/lib/.
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RALPH_DIR="$(cd "$LIB_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$RALPH_DIR/../.." && pwd)"

AGENT_DIR="$PROJECT_ROOT/.agent"
COUNCIL_DIR="$AGENT_DIR/council"
TASKS_FILE="$AGENT_DIR/tasks.json"
TASKS_DETAIL_DIR="$AGENT_DIR/tasks"
PLANNING_STATUS="$AGENT_DIR/planning-status.json"
REVIEWS_DIR="$AGENT_DIR/reviews"
LOG_FILE="$AGENT_DIR/logs/LOG.md"
HISTORY_DIR="$AGENT_DIR/history"

# Configurable models / limits (env-overridable).
RALPH_CLAUDE_MODEL="${RALPH_CLAUDE_MODEL:-opus}"
RALPH_CODEX_MODEL="${RALPH_CODEX_MODEL:-gpt-5.5}"
RALPH_GEMINI_MODEL="${RALPH_GEMINI_MODEL:-gemini-2.5-pro}"
RALPH_BUILD_BRANCH="${RALPH_BUILD_BRANCH:-ralph/build}"
MAX_PLAN_ROUNDS="${MAX_PLAN_ROUNDS:-3}"
MAX_REVIEW_ROUNDS="${MAX_REVIEW_ROUNDS:-3}"

# Exit codes (mirror upstream ralph constants.sh).
EXIT_COMPLETE=0
EXIT_MAX_ITERATIONS=1
EXIT_BLOCKED=2
EXIT_DECIDE=3
EXIT_PRECONDITION=5

C_B="\033[1m"; C_R="\033[0m"; C_DIM="\033[2m"
log()   { echo -e "${C_B}[ralph]${C_R} $*"; }
dim()   { echo -e "${C_DIM}$*${C_R}"; }
die()   { echo -e "\033[31m[ralph] FATAL:${C_R} $*" >&2; exit "${2:-1}"; }

require_cmds() {
  local missing=()
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
  [ ${#missing[@]} -eq 0 ] || die "missing required commands: ${missing[*]}" $EXIT_PRECONDITION
}

# --- planning-status helpers ---
planning_status() { jq -r '.status // "not_started"' "$PLANNING_STATUS" 2>/dev/null || echo "not_started"; }

set_planning_status() {
  local status="$1"; local note="${2:-}"
  local tmp; tmp="$(mktemp)"
  jq --arg s "$status" --arg n "$note" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.status=$s | .latestNote=$n | (.revision=((.revision // 0)+1)) |
     (if $s=="approved" then .approvedAt=$t else . end)' \
    "$PLANNING_STATUS" 2>/dev/null > "$tmp" || echo "{\"status\":\"$status\",\"latestNote\":\"$note\",\"revision\":1}" > "$tmp"
  mv "$tmp" "$PLANNING_STATUS"
}

# --- git helpers ---
require_git_commit_capable() {
  git -C "$PROJECT_ROOT" config user.name  >/dev/null 2>&1 \
    && git -C "$PROJECT_ROOT" config user.email >/dev/null 2>&1 \
    || die "git identity not configured (user.name/user.email) — per-task commits would fail" $EXIT_PRECONDITION
}

ensure_build_branch() {
  git -C "$PROJECT_ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repo" $EXIT_PRECONDITION
  local cur; cur="$(git -C "$PROJECT_ROOT" branch --show-current)"
  [ "$cur" = "$RALPH_BUILD_BRANCH" ] && return 0
  if git -C "$PROJECT_ROOT" rev-parse --verify "$RALPH_BUILD_BRANCH" >/dev/null 2>&1; then
    # Branch already exists (a resumed run) — switch to it WITHOUT resetting its
    # per-task commits. -B would reset to the current HEAD and lose progress.
    log "resuming on existing build branch $RALPH_BUILD_BRANCH (from $cur)"
    git -C "$PROJECT_ROOT" checkout "$RALPH_BUILD_BRANCH" >/dev/null 2>&1 \
      || die "could not switch to existing $RALPH_BUILD_BRANCH (worktree conflict?)" $EXIT_PRECONDITION
  else
    log "creating build branch $RALPH_BUILD_BRANCH (from $cur)"
    git -C "$PROJECT_ROOT" checkout -b "$RALPH_BUILD_BRANCH" >/dev/null 2>&1 \
      || die "could not create $RALPH_BUILD_BRANCH" $EXIT_PRECONDITION
  fi
}

# Defensively keep secret-bearing files OUT of every commit, even if a stale
# index or a missing gitignore rule would otherwise include them. (A vim .env.swp
# once leaked into a baseline via `git add -A`.) Call after every `git add -A`.
guard_secret_files() {
  for p in .env .env.local .env.swp .dev.vars .dev.vars.local; do
    git -C "$PROJECT_ROOT" rm -q --cached --ignore-unmatch "$p" >/dev/null 2>&1 || true
  done
  git -C "$PROJECT_ROOT" ls-files -z -- '*.swp' '*.swo' '.env' '.env.*' '.dev.vars*' 2>/dev/null \
    | grep -zv '\.example$' \
    | xargs -0 -r git -C "$PROJECT_ROOT" rm -q --cached --ignore-unmatch >/dev/null 2>&1 || true
}

# Per-task commits are the rollback boundary, and each per-task diff must contain
# ONLY that task's work. Any pre-existing dirty state (e.g. the harness + approved
# plan laid by skills 14/15, or unrelated edits) is captured in ONE labeled
# baseline commit up front so it can never leak into a task's diff/commit.
ensure_clean_baseline() {
  if [ -n "$(git -C "$PROJECT_ROOT" status --porcelain)" ]; then
    log "dirty worktree at build start — capturing a baseline commit so task diffs stay isolated"
    git -C "$PROJECT_ROOT" add -A
    guard_secret_files
    git -C "$PROJECT_ROOT" -c core.hooksPath=/dev/null commit -q \
      -m "chore(ralph): baseline before build loop" \
      -m "Captures the harness + approved plan + any pre-existing changes." \
      || die "baseline commit failed (git identity?)" $EXIT_PRECONDITION
  fi
}

# When a task aborts mid-flight (review rejection, no diff, commit failure, or a
# BLOCKED/DECIDE from the implementer), its uncommitted changes MUST NOT be left
# dirty — otherwise the next run's ensure_clean_baseline() would sweep that
# never-reviewed code into a baseline commit, bypassing the review gate. Preserve
# the attempt in a stash (forensics, out of the commit path) and restore the
# worktree to the last good commit.
stash_attempt() {
  local id="$1" label="$2"
  if [ -n "$(git -C "$PROJECT_ROOT" status --porcelain)" ]; then
    git -C "$PROJECT_ROOT" stash push -u -q -m "ralph-${label}-${id}" 2>/dev/null \
      || { git -C "$PROJECT_ROOT" reset --hard -q HEAD; git -C "$PROJECT_ROOT" clean -fdq 2>/dev/null || true; }
    log "   attempt for $id preserved in stash 'ralph-${label}-${id}', worktree restored to HEAD"
  fi
}

# Stage everything and commit it as the task's commit. Returns:
#   0 committed · 2 nothing staged (implementer produced no diff) · other = commit error.
# Never swallows a failure as success — the caller must treat non-zero as fatal.
commit_task() {
  local id="$1"; local title="$2"
  git -C "$PROJECT_ROOT" add -A
  guard_secret_files
  if git -C "$PROJECT_ROOT" diff --cached --quiet; then
    log "no staged changes for $id — nothing to commit"; return 2
  fi
  git -C "$PROJECT_ROOT" -c core.hooksPath=/dev/null commit -q \
    -m "feat($id): $title" \
    -m "Implemented and council-approved (Codex + Gemini) via ralph build loop." \
    -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
}

reap_dev_servers() {
  for port in 3000 5173 8788 8787; do
    if command -v fuser >/dev/null 2>&1; then
      fuser -k "${port}/tcp" >/dev/null 2>&1 || true
    elif command -v lsof >/dev/null 2>&1; then
      lsof -ti "tcp:${port}" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
    fi
  done
}

log_entry() {
  mkdir -p "$(dirname "$LOG_FILE")"
  [ -f "$LOG_FILE" ] || printf '# Ralph Build Log\n\n' > "$LOG_FILE"
  local tmp; tmp="$(mktemp)"
  { printf '## %s — %s\n%s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "${2:-}"; cat "$LOG_FILE"; } > "$tmp"
  mv "$tmp" "$LOG_FILE"
}
