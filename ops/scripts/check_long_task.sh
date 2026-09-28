#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   check_long_task.sh <task_id>

TASK_ID="${1:?task_id required}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
STATE_DIR="${WORKSPACE_ROOT}/runtime/long_tasks/${TASK_ID}"
PID_FILE="$STATE_DIR/task.pid"
STATE_FILE="$STATE_DIR/state.json"

if [[ ! -f "$PID_FILE" ]]; then
  echo "task not found: $TASK_ID"
  exit 1
fi

PID="$(cat "$PID_FILE")"
if ps -p "$PID" >/dev/null 2>&1; then
  STATUS="running"
  ETIME="$(ps -o etime= -p "$PID" | xargs)"
else
  STATUS="stopped"
  ETIME="-"
fi

echo "task_id=$TASK_ID"
echo "pid=$PID"
echo "status=$STATUS"
echo "etime=$ETIME"

[[ -f "$STATE_FILE" ]] && { echo "state:"; cat "$STATE_FILE"; }
[[ -f "$STATE_DIR/heartbeat.log" ]] && { echo "--- heartbeat (tail) ---"; tail -n 10 "$STATE_DIR/heartbeat.log"; }
