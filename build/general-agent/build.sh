#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
docker build -f "$root/build/general-agent/Dockerfile" -t "${1:-auto-test-general-agent:local}" "$root"
