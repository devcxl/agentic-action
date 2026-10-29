#!/usr/bin/env bash
set -euo pipefail

PI_VERSION="${PI_VERSION:-1.4.0}"
export PATH="$HOME/.pi-cli/bin:$PATH"

if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$HOME/.pi-cli/bin" >> "$GITHUB_PATH"
fi

if [ "$PI_VERSION" = "latest" ]; then
  echo "Installing latest Pi Coding Agent..."
elif [ -x "$HOME/.pi-cli/bin/pi" ]; then
  INSTALLED_VER=$("$HOME/.pi-cli/bin/pi" --version 2>/dev/null || true)
  if [ "$INSTALLED_VER" = "$PI_VERSION" ]; then
    echo "Using cached Pi CLI v${INSTALLED_VER}"
    exit 0
  fi
fi

mkdir -p "$HOME/.pi-cli"
for attempt in 1 2 3; do
  if npm install -g --prefix "$HOME/.pi-cli" --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}"; then
    exit 0
  fi
  echo "[setup-pi-cli] npm install attempt ${attempt} failed, retrying..." >&2
  if [ "$attempt" -lt 3 ]; then
    sleep 3
  fi
done
exit 1
