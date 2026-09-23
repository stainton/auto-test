#!/bin/sh
set -eu
executor_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
docker build -f "$executor_root/build/executor/Dockerfile" -t "${1:-auto-test-executor:local}" "$executor_root"
