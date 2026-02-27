#!/bin/bash
# Post-update hook: runs after runtime update on EC2 instances
# Checks if a staged upload-server update exists and applies it

STAGED="/tmp/upload-server-new.js"
TARGET="/home/ubuntu/upload-server.js"
BACKUP="/home/ubuntu/upload-server-backup.js"

if [ -f "$STAGED" ]; then
    echo "[post-update] Found staged upload-server update, applying..."
    cp "$TARGET" "$BACKUP" 2>/dev/null || true
    cp "$STAGED" "$TARGET"
    rm "$STAGED"
    
    # Kill the upload server process - systemd Restart=always will restart with new code
    pkill -f "node /home/ubuntu/upload-server.js" 2>/dev/null || true
    echo "[post-update] Upload server updated and restarting via systemd"
else
    echo "[post-update] No staged upload-server update found"
fi
