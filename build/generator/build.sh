#!/bin/sh
set -eu
generator_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
base=$(sh "$(dirname -- "$0")/../base/build.sh")
docker build --build-arg "BROWSER_BASE=$base" -f "$generator_root/build/generator/Dockerfile" -t "${1:-auto-test-generator:local}" "$generator_root"
