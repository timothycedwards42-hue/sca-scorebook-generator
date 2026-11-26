#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname -- "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
if [ -f "$SCRIPT_DIR/package.json" ]; then
  cd "$SCRIPT_DIR"
else
  cd "$HOME/Desktop/sca-scorebook-generator"
fi
echo "Starting SCA Digital Scorebook local web app..."
npm start
