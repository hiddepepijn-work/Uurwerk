#!/usr/bin/env bash
# Ships packages/server to the VPS and (re)starts it. Run from the repo root:
#   bash packages/server/deploy/deploy.sh [ubuntu@51.75.74.94]
#
# First run also creates the service user, the data directory and the Caddy block.
# Data in /var/lib/uurwerk is never touched.
set -euo pipefail

TARGET="${1:-ubuntu@51.75.74.94}"

npm run build:server
tar -C packages/server -czf /tmp/uurwerk-server.tgz --exclude=node_modules --exclude=data .
scp -q /tmp/uurwerk-server.tgz "$TARGET:/tmp/uurwerk-server.tgz"

ssh "$TARGET" 'bash -s' <<'REMOTE'
set -euo pipefail
id uurwerk >/dev/null 2>&1 || sudo useradd --system --home /var/lib/uurwerk --shell /usr/sbin/nologin uurwerk
sudo mkdir -p /opt/uurwerk-server /var/lib/uurwerk
sudo chown uurwerk:uurwerk /var/lib/uurwerk
sudo chmod 700 /var/lib/uurwerk

sudo tar -C /opt/uurwerk-server -xzf /tmp/uurwerk-server.tgz
rm /tmp/uurwerk-server.tgz
cd /opt/uurwerk-server && sudo npm install --omit=dev --no-audit --no-fund --loglevel=error

sudo cp deploy/uurwerk-server.service /etc/systemd/system/uurwerk-server.service
sudo systemctl daemon-reload
sudo systemctl enable --quiet uurwerk-server
sudo systemctl restart uurwerk-server

if ! sudo grep -q 'uurwerk.duckdns.org' /etc/caddy/Caddyfile; then
  # Built and validated as a copy first: Reisbouwer shares this file, and a broken one on
  # disk would take it down at the next Caddy restart.
  sudo cat /etc/caddy/Caddyfile deploy/Caddyfile.uurwerk > /tmp/Caddyfile.nieuw
  sudo caddy validate --config /tmp/Caddyfile.nieuw --adapter caddyfile
  sudo cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.voor-uurwerk-$(date +%F)"
  sudo cp /tmp/Caddyfile.nieuw /etc/caddy/Caddyfile
  rm -f /tmp/Caddyfile.nieuw
  sudo systemctl reload caddy
fi

sleep 2
sudo systemctl is-active uurwerk-server
REMOTE
