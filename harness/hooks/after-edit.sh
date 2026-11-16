#!/bin/sh
# Claude Code hook (PostToolUse on Edit/Write): after a change to the app's code (hoopstat/*.js outside vendor/),
# run the fast unit tests. Silent when they pass; on a failure, exit 2 so Claude sees which tests failed.
f=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty')
case "$f" in
  */hoopstat/vendor/*) exit 0 ;;
  */hoopstat/*.js) ;;
  *) exit 0 ;;
esac
root="${f%%/hoopstat/*}"
out=$(cd "$root" && node --test hoopstat/tests/flow.test.js hoopstat/tests/game.test.js hoopstat/tests/players.test.js 2>&1)
if echo "$out" | grep -q '^# fail 0'; then exit 0; fi
echo "Unit tests failed after editing $f:" >&2
echo "$out" | grep -E '^not ok|^# (tests|pass|fail)|expected|actual|Error' | head -30 >&2
exit 2
