#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   run_long_task.sh <task_id> <workdir> <command...>

TASK_ID="${1:?task_id required}"
WORKDIR="${2:?workdir required}"
shift 2

WORKSPACE_ROOT="${WORKSPACE_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
STATE_DIR="${WORKSPACE_ROOT}/runtime/long_tasks/${TASK_ID}"
mkdir -p "$STATE_DIR"

PID_FILE="$STATE_DIR/task.pid"
STATE_FILE="$STATE_DIR/state.json"
LOG_FILE="$STATE_DIR/heartbeat.log"
CMD_FILE="$STATE_DIR/command.txt"

printf '%s\n' "$*" > "$CMD_FILE"

echo "[$(date '+%F %T')] starting task_id=$TASK_ID" | tee -a "$LOG_FILE"

(
  cd "$WORKDIR"
  nohup "$@" >> "$STATE_DIR/stdout.log" 2>> "$STATE_DIR/stderr.log" &
  CHILD_PID=$!
  echo "$CHILD_PID" > "$PID_FILE"
  printf '{"task_id":"%s","status":"running","pid":%s,"started_at":"%s"}\n' "$TASK_ID" "$CHILD_PID" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$STATE_FILE"
  echo "[$(date '+%F %T')] pid=$CHILD_PID" | tee -a "$LOG_FILE"
)

echo "started: $TASK_ID"
