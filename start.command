#!/bin/bash
# Double-click this file to start Code Scanner and open it in your browser.
cd "$(dirname "$0")"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/Users/fraternebahirwe/.nvm/versions/node/v20.20.2/bin"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install it from https://nodejs.org and try again."
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi
(sleep 1; open "http://localhost:4455") &
node server.js
