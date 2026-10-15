#!/bin/sh
# Builds (or reuses, if an image with this tag already exists locally, e.g. pulled from a registry) the browser base image and prints its tag on stdout.
# The tag carries the Playwright version pinned in build/planner/package.json, so bumping it rebuilds the base.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
version=$(sed -n 's/.*"@playwright\/test": *"\([0-9][0-9.]*\)".*/\1/p' "$root/build/planner/package.json")
[ -n "$version" ] || { echo "build/planner/package.json must pin an exact @playwright/test version" >&2; exit 1; }
tag="${BROWSER_BASE_IMAGE:-auto-test-browser-base}:$version"
if ! docker image inspect "$tag" >/dev/null 2>&1; then
  docker build -f "$root/build/base/Dockerfile" --build-arg "PLAYWRIGHT_VERSION=$version" -t "$tag" "$root/build/base" >&2
fi
echo "$tag"
