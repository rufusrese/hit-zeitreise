#!/usr/bin/env bash
# Überträgt die App auf den Server und startet den Container neu.
set -euo pipefail
HOST=${HOST:-ubuntu@164.30.74.140}
DIR=/opt/hit-zeitreise
cd "$(dirname "$0")"
rsync -az --delete --exclude node_modules --exclude data --exclude .git ./ "$HOST:$DIR/"
ssh "$HOST" "cd $DIR && mkdir -p data && docker compose up -d --build && docker image prune -f >/dev/null"
