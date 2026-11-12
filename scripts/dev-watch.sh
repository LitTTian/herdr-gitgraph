#!/bin/bash
# Poll the project and sync on change. Portable stand-in for fswatch.
set -euo pipefail

src="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
last=""

checksum() {
  (cd "$src" && find . \
    -path ./.git -prune -o \
    -path ./.scratch -prune -o \
    -path ./node_modules -prune -o \
    -type f -print | sort | xargs shasum | shasum)
}

echo "watching $src (ctrl-c to stop)"
while true; do
  sum="$(checksum)"
  if [ "$sum" != "$last" ]; then
    last="$sum"
    bash "$src/scripts/dev-sync.sh"
  fi
  sleep 1
done
