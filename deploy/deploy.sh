#!/usr/bin/env bash
# Deploy to another machine as a systemd user service on :6868.
#   ./deploy/deploy.sh user@host
# IMPASTO_PORT / IMPASTO_DATA on the target come from deploy/impasto.service.
set -euo pipefail
HOST=${1:-${IMPASTO_DEPLOY_HOST:-}}
if [ -z "$HOST" ]; then
  echo "usage: ./deploy/deploy.sh user@host   (or set IMPASTO_DEPLOY_HOST)" >&2
  exit 2
fi
cd "$(dirname "$0")/.."
rsync -a --delete --exclude .venv --exclude _x --exclude data --exclude __pycache__ --exclude .pytest_cache \
      --exclude .playwright-mcp --exclude '*.gcode' --exclude '*.3mf' --exclude .git ./ "$HOST:impasto/"
ssh "$HOST" 'set -e; cd ~/impasto
  [ -x .venv/bin/python ] || python3 -m venv .venv
  .venv/bin/pip install -q --upgrade pip >/dev/null
  .venv/bin/pip install -q -r requirements.txt
  mkdir -p ~/.config/systemd/user data
  cp deploy/impasto.service ~/.config/systemd/user/
  rm -rf npg        # leftover from the old package name (rsync keeps __pycache__)
  # drop the unit of the old name (it held the same port)
  systemctl --user disable --now npgcoder.service 2>/dev/null || true
  rm -f ~/.config/systemd/user/npgcoder.service
  systemctl --user daemon-reload
  systemctl --user enable --now impasto.service
  systemctl --user restart impasto.service
  sleep 2; systemctl --user is-active impasto.service; curl -s localhost:6868/api/version; echo'
