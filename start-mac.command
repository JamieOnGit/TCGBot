#!/bin/bash
# Double-click to start TCGBot on macOS (or run ./start-mac.command on Linux).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Download the LTS version from https://nodejs.org, install it, then run this again."
  read -r -p "Press Enter to close."
  exit 1
fi
if [ ! -d node_modules/playwright ]; then
  echo "First run: installing TCGBot's browser automation. This takes a minute..."
  npm run setup || { read -r -p "Setup failed. Press Enter to close."; exit 1; }
fi
node src/index.js
