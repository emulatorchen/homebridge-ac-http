#!/usr/bin/env bash
# verify-tiles.sh — end-to-end tile label verification via real HAP pairing.
# Runs entirely in Docker; touches nothing on the host.
#
# Usage: ./verify-tiles.sh
set -euo pipefail

HB="homebridge-ac-http-homebridge-test-1"
COMPOSE="docker compose -f docker-compose.test.yml"

echo "=== Step 1: build plugin and test containers ==="
npm run build --silent
$COMPOSE build homebridge-test hap-verify 2>&1 | grep -E "Built|Error" || true

echo ""
echo "=== Step 2: (re)start Homebridge with fresh volume ==="
$COMPOSE down -v homebridge-test 2>/dev/null || true
$COMPOSE up -d homebridge-test

echo "Waiting for Homebridge to start..."
for i in $(seq 1 30); do
  if docker exec "$HB" sh -c "test -f /homebridge/persist/AccessoryInfo.AABBCCDDEEFF.json" 2>/dev/null; then
    break
  fi
  sleep 2
done

echo ""
echo "=== Step 3: read actual PIN from running bridge ==="
PIN=$(docker exec "$HB" sh -c \
  "node -e \"const d=require('/homebridge/persist/AccessoryInfo.AABBCCDDEEFF.json'); console.log(d.pincode)\"" \
  2>/dev/null || \
  docker exec "$HB" sh -c \
  "node -e \"console.log(require('/homebridge/config.json').bridge.pin)\"" \
)
echo "PIN: $PIN"

PORT=$(docker exec "$HB" sh -c \
  "node -e \"const d=require('/homebridge/persist/AccessoryInfo.AABBCCDDEEFF.json'); console.log(d.port||51826)\"" \
  2>/dev/null || echo "51826")
echo "PORT: $PORT"

echo ""
echo "=== Step 4: pair via HAP and list tiles ==="
docker run --rm --network host \
  homebridge-ac-http-hap-verify \
  sh -c "sleep 2 && node /app/hap-verify.mjs 127.0.0.1 $PORT $PIN"

echo ""
echo "=== Done ==="
