#!/usr/bin/env bash
# Runs ON the VPS: installs the bundle it was unpacked from. deploy.sh starts it with one
# short command, because larger transfers from the home network to the VPS get reset.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"

id uurwerk >/dev/null 2>&1 || sudo useradd --system --home /var/lib/uurwerk --shell /usr/sbin/nologin uurwerk
sudo mkdir -p /opt/uurwerk-server /var/lib/uurwerk
sudo chown uurwerk:uurwerk /var/lib/uurwerk
sudo chmod 700 /var/lib/uurwerk

sudo cp -a "$SRC/." /opt/uurwerk-server/
cd /opt/uurwerk-server && sudo npm install --omit=dev --no-audit --no-fund --loglevel=error

sudo cp deploy/uurwerk-server.service /etc/systemd/system/uurwerk-server.service
sudo systemctl daemon-reload
sudo systemctl enable --quiet uurwerk-server
sudo systemctl restart uurwerk-server

if ! sudo grep -q 'uurwerk.duckdns.org' /etc/caddy/Caddyfile; then
  sudo cat /etc/caddy/Caddyfile deploy/Caddyfile.uurwerk > /tmp/Caddyfile.nieuw
  sudo caddy validate --config /tmp/Caddyfile.nieuw --adapter caddyfile
  sudo cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.voor-uurwerk-$(date +%F)"
  sudo cp /tmp/Caddyfile.nieuw /etc/caddy/Caddyfile
  rm -f /tmp/Caddyfile.nieuw
  sudo systemctl reload caddy
fi

sleep 2
sudo systemctl is-active uurwerk-server
