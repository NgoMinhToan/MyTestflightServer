#!/bin/sh
set -eu
mkdir -p "$DATA_DIR/apps" 2>/dev/null || true
if [ "$(id -u)" = "0" ]; then
  # Best-effort: bind mounts on Docker Desktop/NFS/rootless may reject chown.
  # Skip the recursive pass when ownership already matches, so large APK
  # volumes are not rescanned on every start.
  if [ "$(stat -c %u "$DATA_DIR" 2>/dev/null || echo 0)" != "$(id -u node)" ]; then
    chown -R node:node "$DATA_DIR" 2>/dev/null || true
  fi
  exec su-exec node "$@"
fi
exec "$@"
