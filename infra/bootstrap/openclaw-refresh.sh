#!/usr/bin/env bash
set -euo pipefail

# OpenClaw Runtime Refresh Script
# Builds the runtime to /opt/openclaw/runtime/ - completely separate from agent workspace

OPENCLAW_RUNTIME_DIR="/opt/openclaw/runtime"
OPENCLAW_REPO_URL="https://github.com/aron98/openclaw.git"
OPENCLAW_REPO_REF="main"
OPENCLAW_BUILD_MARKER="/opt/openclaw/.last-runtime-build"
OPENCLAW_NODE_HEAP_MB=3072

export HOME="/var/lib/openclaw"
export NODE_OPTIONS="--max-old-space-size=${OPENCLAW_NODE_HEAP_MB}"
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Setup user-local npm global directory
export NPM_CONFIG_PREFIX="/var/lib/openclaw/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
mkdir -p "$NPM_CONFIG_PREFIX/bin"

# Ensure runtime directory exists
mkdir -p "$OPENCLAW_RUNTIME_DIR"

# Clone fresh to runtime directory (never touch agent workspace)
if [ -d "$OPENCLAW_RUNTIME_DIR/.git" ]; then
  echo "Updating runtime repo..."
  git -C "$OPENCLAW_RUNTIME_DIR" fetch --prune origin
  git -C "$OPENCLAW_RUNTIME_DIR" checkout "$OPENCLAW_REPO_REF"
  git -C "$OPENCLAW_RUNTIME_DIR" reset --hard "origin/$OPENCLAW_REPO_REF"
else
  echo "Cloning runtime repo..."
  git clone "$OPENCLAW_REPO_URL" "$OPENCLAW_RUNTIME_DIR"
  git -C "$OPENCLAW_RUNTIME_DIR" checkout "$OPENCLAW_REPO_REF"
fi

# Check if we need to rebuild
current_rev="$(git -C "$OPENCLAW_RUNTIME_DIR" rev-parse HEAD)"
last_rev=""
if [ -f "$OPENCLAW_BUILD_MARKER" ]; then
  last_rev="$(cat "$OPENCLAW_BUILD_MARKER")"
fi

if [ "$current_rev" != "$last_rev" ] || [ ! -d "$OPENCLAW_RUNTIME_DIR/dist" ]; then
  echo "Building runtime from $current_rev..."
  
  # Build in runtime directory
  cd "$OPENCLAW_RUNTIME_DIR"
  pnpm install --frozen-lockfile
  pnpm ui:build || echo "UI build skipped or failed, continuing..."
  pnpm build
  
  # Protect the runtime: make it read-only for the openclaw user
  chown -R root:openclaw "$OPENCLAW_RUNTIME_DIR/dist"
  chmod -R 755 "$OPENCLAW_RUNTIME_DIR/dist"
  
  # Mark successful build
  echo "$current_rev" > "$OPENCLAW_BUILD_MARKER"
  
  echo "Runtime built and protected successfully at $OPENCLAW_RUNTIME_DIR"
else
  echo "Runtime is up to date ($current_rev)"
fi

# Ensure the entry point is executable
chmod +x "$OPENCLAW_RUNTIME_DIR/openclaw.mjs" 2>/dev/null || true
