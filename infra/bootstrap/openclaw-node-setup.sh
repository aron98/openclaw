#!/usr/bin/env bash
set -euo pipefail

# OpenClaw Node Setup Script
# Configures npm for the openclaw user to allow global installs without sudo
# Run this once after instance setup, or include in bootstrap

OPENCLAW_STATE_DIR="/var/lib/openclaw"
NPM_GLOBAL_DIR="$OPENCLAW_STATE_DIR/.npm-global"
NPMRC_FILE="$OPENCLAW_STATE_DIR/.npmrc"
ZSHRC_FILE="$OPENCLAW_STATE_DIR/.zshrc"
BASHRC_FILE="$OPENCLAW_STATE_DIR/.bashrc"

echo "Setting up user-local npm configuration..."

# Create global npm directory
mkdir -p "$NPM_GLOBAL_DIR/bin"

# Configure npm to use the local directory
if [ -f "$NPMRC_FILE" ]; then
  # Update existing prefix if present
  if grep -q "^prefix=" "$NPMRC_FILE"; then
    sed -i "s|^prefix=.*|prefix=$NPM_GLOBAL_DIR|" "$NPMRC_FILE"
  else
    echo "prefix=$NPM_GLOBAL_DIR" >> "$NPMRC_FILE"
  fi
else
  echo "prefix=$NPM_GLOBAL_DIR" > "$NPMRC_FILE"
fi

# Ensure PATH is set in shell configs
add_path_to_shell_config() {
  local config_file="$1"
  if [ -f "$config_file" ]; then
    if ! grep -q "NPM_GLOBAL_DIR" "$config_file"; then
      echo "" >> "$config_file"
      echo "# OpenClaw npm global directory" >> "$config_file"
      echo 'export NPM_CONFIG_PREFIX="$HOME/.npm-global"' >> "$config_file"
      echo 'export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"' >> "$config_file"
      echo "Updated $config_file"
    fi
  fi
}

add_path_to_shell_config "$ZSHRC_FILE"
add_path_to_shell_config "$BASHRC_FILE"

# Also set system-wide for systemd services and current session
export NPM_CONFIG_PREFIX="$NPM_GLOBAL_DIR"
export PATH="$NPM_GLOBAL_DIR/bin:$PATH"

echo "Npm global directory: $NPM_GLOBAL_DIR"
echo "Current npm prefix: $(npm config get prefix)"

# Test global install capability
echo "Testing global install capability..."
if npm install -g pnpm 2>/dev/null; then
  echo "✅ Global npm installs are now working!"
  echo "Location: $(which pnpm 2>/dev/null || echo 'Not in PATH yet')"
else
  echo "⚠️  Global install test had issues, but configuration is set"
fi

echo ""
echo "Setup complete. You may need to restart your shell or run:"
echo "  export PATH=\"$NPM_GLOBAL_DIR/bin:\$PATH\""
