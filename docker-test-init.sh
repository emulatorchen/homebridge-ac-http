#!/bin/sh
# Runs before s6/supervisor. Seeds plugin and config into the (now-mounted) volume.

PLUGIN_SRC=/tmp/homebridge-ac-http
PLUGIN_DST=/homebridge/node_modules/homebridge-ac-http
CONFIG=/homebridge/config.json

mkdir -p /homebridge/node_modules

echo "[test-init] copying plugin to $PLUGIN_DST"
cp -r "$PLUGIN_SRC" "$PLUGIN_DST" && \
  echo "[test-init] plugin copy OK" || echo "[test-init] plugin copy FAILED"

echo "[test-init] seeding config"
cp /tmp/docker-test-config.json "$CONFIG" && \
  echo "[test-init] config seed OK" || echo "[test-init] config seed FAILED"

echo "[test-init] handing off to /init"
exec /init "$@"
