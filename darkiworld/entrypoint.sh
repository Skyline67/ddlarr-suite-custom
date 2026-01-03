#!/bin/bash
set -e

# Start Xvfb (X Virtual Framebuffer) for virtual display
echo "Starting Xvfb virtual display on :99..."
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!

# Wait for Xvfb to start
sleep 2

# Verify Xvfb is running
if kill -0 $XVFB_PID 2>/dev/null; then
    echo "✓ Xvfb started successfully (PID: $XVFB_PID)"
else
    echo "✗ Failed to start Xvfb"
    exit 1
fi

# Export display
export DISPLAY=:99
echo "✓ DISPLAY set to $DISPLAY"

# Start dbus if available (helps with some Chrome features)
if command -v dbus-daemon &> /dev/null; then
    echo "Starting D-Bus..."
    mkdir -p /var/run/dbus
    dbus-daemon --system --fork 2>/dev/null || true
    echo "✓ D-Bus started"
fi

# Execute the main command
echo "Starting application..."
exec "$@"
