#!/usr/bin/env bash
set -euo pipefail

# OpenClaw Bootstrap Deploy Script
# Deploys/updates system scripts from the repo to system locations
# Run manually or via GitHub Actions after merge to main

OPENCLAW_REPO_DIR="${OPENCLAW_REPO_DIR:-/opt/openclaw/runtime}"
BOOTSTRAP_DIR="$OPENCLAW_REPO_DIR/infra/bootstrap"

echo "Deploying OpenClaw bootstrap scripts..."

pnpm install --frozen-lockfile
sudo pnpm ui:build || echo "UI build skipped or failed, continuing..."
sudo pnpm build
sudo chown -R root:openclaw "$OPENCLAW_REPO_DIR"
sudo chmod -R 755 "$OPENCLAW_REPO_DIR"
sudo chmod +x "$OPENCLAW_REPO_DIR/openclaw.mjs" 2>/dev/null || true

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Error: This script must be run as root (use sudo)"
  exit 1
fi

# Verify bootstrap directory exists
if [ ! -d "$BOOTSTRAP_DIR" ]; then
  echo "Error: Bootstrap directory not found at $BOOTSTRAP_DIR"
  exit 1
fi

# Deploy openclaw-node-setup script
if [ -f "$BOOTSTRAP_DIR/openclaw-node-setup.sh" ]; then
  echo "Deploying openclaw-node-setup..."
  cp "$BOOTSTRAP_DIR/openclaw-node-setup.sh" /usr/local/bin/openclaw-node-setup
  chmod +x /usr/local/bin/openclaw-node-setup
else
  echo "Warning: openclaw-node-setup.sh not found in bootstrap directory"
fi

# Deploy systemd service file
if [ -f "$BOOTSTRAP_DIR/openclawd.service" ]; then
  echo "Deploying openclawd.service..."
  cp "$BOOTSTRAP_DIR/openclawd.service" /etc/systemd/system/openclawd.service
  systemctl daemon-reload
  echo "Systemd daemon reloaded"
else
  echo "Warning: openclawd.service not found in bootstrap directory"
fi

echo ""
echo "Bootstrap deployment complete!"
echo ""
echo "Next steps:"
echo "  1. Run 'systemctl restart openclawd' to apply service changes"
echo "  2. Run 'openclaw-node-setup' to configure npm (if first deploy)"
echo "  3. Check 'systemctl status openclawd' to verify"
