#!/bin/sh
set -e
docker build -t pi-egress-proxy:test ./proxy
docker run --rm --entrypoint sh -v "$(pwd)/proxy:/proxy" pi-egress-proxy:test \
  -c "pip install -q pytest && cd /proxy && python -m pytest tests/ -v"
