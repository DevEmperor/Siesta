#!/bin/sh
# Packs the add-on into dist/siesta-<version>.xpi (unsigned, for testing).
set -e
cd "$(dirname "$0")/.."
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -n 1)
mkdir -p dist
out="dist/siesta-$version.xpi"
rm -f "$out"
zip -q -r -X "$out" manifest.json background.js lib popup icons fonts LICENSE
echo "$out"
