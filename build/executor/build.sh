#!/bin/sh
set -eu
executor_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
base=$(sh "$(dirname -- "$0")/../base/build.sh")
docker build --build-arg "BROWSER_BASE=$base" -f "$executor_root/build/executor/Dockerfile" -t "${1:-auto-test-executor:local}" "$executor_root"
