#!/bin/sh
set -eu
# --mount=type=cache in the Dockerfile needs BuildKit (the default since Docker 23).
export DOCKER_BUILDKIT=1
planner_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
base=$(sh "$(dirname -- "$0")/../base/build.sh")
docker build --build-arg "BROWSER_BASE=$base" -f "$planner_root/build/planner/Dockerfile" -t "${1:-auto-test-planner:local}" "$planner_root"
