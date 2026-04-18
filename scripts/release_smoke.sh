#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: scripts/release_smoke.sh <packed-tarball>" >&2
  exit 1
fi

PACK_FILE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
if [ ! -f "$PACK_FILE" ]; then
  echo "packed tarball not found: $PACK_FILE" >&2
  exit 1
fi

TMP_BASE="${TMPDIR:-/tmp}"
TMP_ROOT="$(mktemp -d "$TMP_BASE/aixsmk.XXXXXX")"
cleanup() {
  rm -rf "$TMP_ROOT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

PKG_ROOT="$TMP_ROOT/pkg"
HOME_DIR="$TMP_ROOT/home"
mkdir -p "$PKG_ROOT" "$HOME_DIR"

cd "$PKG_ROOT"
npm init -y >/dev/null 2>&1
npm install "$PACK_FILE" >/dev/null 2>&1

export HOME="$HOME_DIR"
unset AGENTINBOX_SOCKET
unset AGENTINBOX_URL
FRESH_HOME="$TMP_ROOT/f1"
LEGACY_HOME="$TMP_ROOT/f2"
CLI_HOME="$TMP_ROOT/f3"

echo "[smoke] fresh install"
export AGENTINBOX_HOME="$FRESH_HOME"
DB_PATH="$AGENTINBOX_HOME/agentinbox.sqlite"
npx agentinbox --version >/dev/null
npx agentinbox daemon start >/dev/null
npx agentinbox host list >/dev/null
[ -f "$DB_PATH" ]

echo "[smoke] archive pre-v1 database and start fresh"
export AGENTINBOX_HOME="$LEGACY_HOME"
DB_PATH="$AGENTINBOX_HOME/agentinbox.sqlite"
rm -rf "$AGENTINBOX_HOME"
mkdir -p "$AGENTINBOX_HOME"
python3 - "$DB_PATH" <<'PY'
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
conn.execute("create table sources (source_id text primary key, source_type text, source_key text)")
conn.commit()
conn.close()
PY
npx agentinbox daemon start >/dev/null
npx agentinbox host list >/dev/null
[ -f "$DB_PATH" ]
find "$AGENTINBOX_HOME" -maxdepth 1 -name 'agentinbox.sqlite.pre-v1.*.bak*' | grep -q .

echo "[smoke] canonical v1 CLI and HTTP surfaces"
export AGENTINBOX_HOME="$CLI_HOME"
DB_PATH="$AGENTINBOX_HOME/agentinbox.sqlite"
npx agentinbox daemon start >/dev/null
HOST_JSON="$(npx agentinbox host add local_event smoke-local)"
HOST_ID="$(printf '%s' "$HOST_JSON" | node -e 'let input=""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).hostId));')"
SOURCE_JSON="$(npx agentinbox source add "$HOST_ID" events smoke-local)"
SOURCE_ID="$(printf '%s' "$SOURCE_JSON" | node -e 'let input=""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).sourceId));')"
npx agentinbox source schema "$SOURCE_ID" >/dev/null

node - "$AGENTINBOX_HOME/agentinbox.sock" <<'PY'
const http = require("http");

const socketPath = process.argv[2];

function request(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      agent: false,
      socketPath,
      path: pathname,
      method: "GET",
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  const health = await request("/healthz");
  if (health.statusCode !== 200) {
    throw new Error(`healthz failed: ${health.statusCode}`);
  }
  const openapi = await request("/openapi.json");
  if (openapi.statusCode !== 200) {
    throw new Error(`openapi failed: ${openapi.statusCode}`);
  }
  const schema = JSON.parse(openapi.body);
  const raw = JSON.stringify(schema);
  if (raw.includes("/agents/{agentId}/inbox/raw-items")) {
    throw new Error("legacy raw-items endpoint still exposed");
  }
  if (raw.includes("throughItemId") || raw.includes("afterItemId")) {
    throw new Error("legacy inbox paging fields still exposed");
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
PY

echo "[smoke] ok"
