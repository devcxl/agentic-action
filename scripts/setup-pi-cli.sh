#!/usr/bin/env bash
set -euo pipefail

PI_VERSION="${PI_VERSION:-1.4.0}"
export PATH="$HOME/.pi-cli/bin:$PATH"

if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$HOME/.pi-cli/bin" >> "$GITHUB_PATH"
fi

if [ -x "$HOME/.pi-cli/bin/pi" ]; then
  INSTALLED_VER=$("$HOME/.pi-cli/bin/pi" --version 2>/dev/null || true)
  if [ "$PI_VERSION" != "latest" ] && [ "$INSTALLED_VER" = "$PI_VERSION" ]; then
    echo "Using cached Pi CLI v${INSTALLED_VER}"
    exit 0
  fi
fi

if command -v pi >/dev/null 2>&1 && [ "$PI_VERSION" = "latest" ]; then
  echo "Using pre-installed Pi CLI $(pi --version 2>/dev/null || true)"
  exit 0
fi

mkdir -p "$HOME/.pi-cli"
npm install -g --prefix "$HOME/.pi-cli" --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}"
