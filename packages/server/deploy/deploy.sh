#!/usr/bin/env bash
# Ships packages/server to the VPS and (re)starts it. Run from the repo root:
#   bash packages/server/deploy/deploy.sh [ubuntu@51.75.74.94]
#
# Since 26 Sep 2026 larger transfers from the home network to the VPS are reset on the way
# (scp, a piped script, even SSH's post-quantum key exchange). So the bundle goes up to the
# server-latest GitHub release, and the VPS fetches and installs it itself: all this
# machine sends is one short command. deploy/install.sh does the installing.
# Data in /var/lib/uurwerk is never touched.
set -euo pipefail

TARGET="${1:-ubuntu@51.75.74.94}"
URL=https://github.com/hiddepepijn-work/Uurwerk/releases/download/server-latest/uurwerk-server.tgz

npm run build:server
tar -C packages/server -czf uurwerk-server.tgz --exclude=node_modules --exclude=data .
gh release view server-latest >/dev/null 2>&1 ||
  gh release create server-latest --prerelease --title "Uurwerk server (laatste build)" --notes "Serverpakket voor de VPS."
gh release upload server-latest uurwerk-server.tgz --clobber
rm uurwerk-server.tgz

ssh "$TARGET" "rm -rf /tmp/uw && mkdir -p /tmp/uw && curl -fsSL $URL | tar -xz -C /tmp/uw && bash /tmp/uw/deploy/install.sh"
