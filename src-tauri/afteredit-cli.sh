#!/usr/bin/env bash

# AfterEdit CLI Interceptor
# This script is aliased to vim, vi, nano, pico, etc., inside the AfterEdit PTY environment.

FILE="$1"
EDITOR_CMD=$(basename "$0") # e.g., 'vim' or 'nano'

if [ -n "$AFTEREDIT_TTY_ID" ]; then
    # We are running inside the AfterEdit native terminal!
    echo "Opening $FILE in AfterEdit GUI..."
    
    # 1. Send IPC message to Tauri backend to open the file in the editor
    # (In a real implementation, this would be a curl to a local IPC socket or a Rust CLI helper)
    # afteredit-ipc --tty $AFTEREDIT_TTY_ID --open "$FILE" --block
    
    # 2. Block until the GUI signals that the file has been closed (crucial for git commit)
    echo "[AfterEdit] Waiting for file to be closed in GUI..."
    # wait_for_ipc_release
    
    echo "Done."
    exit 0
else
    # We are running outside AfterEdit, fallback to the real editor
    if command -v "real_$EDITOR_CMD" >/dev/null 2>&1; then
        exec "real_$EDITOR_CMD" "$@"
    else
        # Fallback to standard system paths if real_ aliases aren't set
        exec "/usr/bin/$EDITOR_CMD" "$@"
    fi
fi
