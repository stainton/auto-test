#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
docker build -f "$root/build/automation/Dockerfile" -t "${1:-auto-test-automation:local}" "$root"
