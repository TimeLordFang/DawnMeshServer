#!/bin/sh
set -eu

if [ -e .env ] || [ -e livekit.yaml ]; then
  echo "Refusing to overwrite .env or livekit.yaml" >&2
  exit 1
fi

random_value() { openssl rand -hex "$1"; }
instance_id="$(random_value 16)"
access_token="$(random_value 32)"
livekit_key="$(random_value 12)"
livekit_secret="$(random_value 32)"

sed \
  -e "s/replace-with-a-random-instance-id/$instance_id/" \
  -e "s/replace-with-a-random-client-access-token/$access_token/" \
  -e "s/replace-with-livekit-api-key/$livekit_key/g" \
  -e "s/replace-with-at-least-32-random-characters/$livekit_secret/g" \
  config.example.env > .env
sed \
  -e "s/replace-with-livekit-api-key/$livekit_key/g" \
  -e "s/replace-with-at-least-32-random-characters/$livekit_secret/g" \
  livekit.example.yaml > livekit.yaml
chmod 600 .env livekit.yaml
echo "Created .env and livekit.yaml. Set both public URLs before starting."

