#!/bin/sh
# Submits Siesta to addons.mozilla.org (listed channel) for Mozilla's review.
# The AMO API credentials are asked for interactively, so they end up neither in
# files nor in the shell history. Create them at
# https://addons.mozilla.org/developers/addon/api/key/
set -e
cd "$(dirname "$0")/.."

printf 'AMO JWT issuer: '
read -r WEB_EXT_API_KEY
printf 'AMO JWT secret (hidden): '
trap 'stty echo' EXIT INT TERM
stty -echo
read -r WEB_EXT_API_SECRET
stty echo
printf '\n'
export WEB_EXT_API_KEY WEB_EXT_API_SECRET

npx --yes web-ext@10.8.0 lint
npx --yes web-ext@10.8.0 sign \
  --channel=listed \
  --amo-metadata=amo-metadata.json \
  --approval-timeout=0
