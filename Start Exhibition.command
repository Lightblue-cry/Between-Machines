#!/bin/bash

# Finder opens this script in Terminal. Resolve its own folder, including spaces.
exhibition_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "$exhibition_dir" ] || ! cd -- "$exhibition_dir"; then
  printf '\nCould not open the exhibition folder.\n'
  read -r -p "Press Return to close. "
  exit 1
fi

exhibition_node=""
exhibition_path_node="$(command -v node 2>/dev/null || true)"
for candidate in \
  "$exhibition_path_node" \
  "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" \
  /opt/homebrew/bin/node \
  /usr/local/bin/node; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  major_version="$("$candidate" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null)"
  case "$major_version" in
    ''|*[!0-9]*) continue ;;
  esac
  if [ "$major_version" -ge 20 ]; then
    exhibition_node="$candidate"
    break
  fi
done

if [ -z "$exhibition_node" ]; then
  printf '\nThis exhibition needs Node.js 20 or newer.\n'
  printf 'Install the current LTS version from https://nodejs.org/, then open this file again.\n\n'
  read -r -p "Press Return to close. "
  exit 1
fi

printf '\nAn image worth preserving for the next hundred years\n'
printf 'The exhibition will open in your browser when it is ready.\n'
printf 'Keep this Terminal window open while the exhibition runs.\n'
printf 'To stop the server, press Control-C here.\n\n'

"$exhibition_node" server.mjs --open
exhibition_exit_code=$?
if [ "$exhibition_exit_code" -ne 0 ] && [ "$exhibition_exit_code" -ne 130 ]; then
  printf '\nThe exhibition stopped. Please check the message above.\n'
  read -r -p "Press Return to close. "
fi
exit "$exhibition_exit_code"
