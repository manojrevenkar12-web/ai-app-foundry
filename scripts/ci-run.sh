#!/usr/bin/env bash
# Runs a CI step; on failure, prints the tail of its output as a GitHub annotation, because the
# annotation is what shows on the run page without opening logs.
#   scripts/ci-run.sh "<title>" <command...>
set -uo pipefail
title="$1"; shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  tail -n 25 "$log" | cut -c1-400 | sed 's/%/%25/g' | awk 'BEGIN { ORS = "%0A" } { print }' > "$log.tail"
  echo "::error title=${title}::$(cat "$log.tail")"
fi
exit "$status"
