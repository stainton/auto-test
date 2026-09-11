#!/bin/sh
set -eu
planner_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
docker build -f "$planner_root/build/planner/Dockerfile" -t "${1:-auto-test-planner:local}" "$planner_root"
