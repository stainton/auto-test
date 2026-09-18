#!/bin/sh
set -eu
generator_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
docker build -f "$generator_root/build/generator/Dockerfile" -t "${1:-auto-test-generator:local}" "$generator_root"
