#!/usr/bin/env bash
set -euo pipefail

# OpenClaw Runtime Update Script (Manual/Developer Use)
# Use this to force a runtime rebuild without waiting for deploy
# This script runs as root to manage the protected runtime

if [ "$EUID" -ne 0 ]; then
  echo "This script must be run as root (use sudo)"
  exit 1
fi

OPENCLAW_RUNTIME_DIR="/var/lib/openclaw/runtime"
OPENCLAW_BUILD_MARKER="/var/lib/openclaw/.last-runtime-build"

echo "Forcing runtime rebuild..."

# Clear the build marker to force refresh
rm -f "$OPENCLAW_BUILD_MARKER"

# Run the refresh script
/usr/local/bin/openclaw-refresh

# Restart the service
systemctl restart openclawd

echo "Runtime updated and service restarted"
echo "Check status: systemctl status openclawd"
