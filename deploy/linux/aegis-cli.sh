#!/bin/sh
# aegis-cli — read-only loopback client for the AIDriven NetDefense daemon.
#
# Author: PT-dove
#
# Installed at /opt/aidriven-netdefense/bin/aegis-cli and exposed as /usr/bin/aegis-cli
# through a symlink. The interpreter is the bundled runtime, never `env node`: the host
# may have no Node.js at all, and a host Node would be an unverified dependency for a
# security product. Every NODE_* variable that could inject a loader is cleared first,
# for the same reason (ADR-0009 §5.1 does the equivalent on Windows).

set -e

ROOT=/opt/aidriven-netdefense
NODE="$ROOT/app/runtime/node/bin/node"
ENTRY="$ROOT/app/apps/cli/bin.js"

if [ ! -x "$NODE" ]; then
  echo "aegis-cli: bundled runtime missing or not executable: $NODE" >&2
  exit 90
fi
if [ ! -f "$ENTRY" ]; then
  echo "aegis-cli: client entry missing: $ENTRY" >&2
  exit 91
fi

unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED NODE_V8_COVERAGE
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy

exec "$NODE" "$ENTRY" "$@"
