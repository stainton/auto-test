#!/bin/sh
set -eu
planner_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
base=$(sh "$(dirname -- "$0")/../base/build.sh")
docker build --build-arg "BROWSER_BASE=$base" -f "$planner_root/build/planner/Dockerfile" -t "${1:-auto-test-planner:local}" "$planner_root"
