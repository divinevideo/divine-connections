#!/usr/bin/env bash
# ABOUTME: Installs one complete publishing OAuth pair on the preserved Worker.
# ABOUTME: Keeps secret values in hidden input and JSON stdin, with no activation.
set +x
set -euo pipefail
case "${1:-}" in
  youtube) id_key=GOOGLE_CLIENT_ID; secret_key=GOOGLE_CLIENT_SECRET ;;
  tiktok) id_key=TIKTOK_CLIENT_KEY; secret_key=TIKTOK_CLIENT_SECRET ;;
  snapchat) id_key=SNAPCHAT_CLIENT_ID; secret_key=SNAPCHAT_CLIENT_SECRET ;;
  *) echo 'Usage: bash scripts/install-publishing-secrets.sh youtube|tiktok|snapchat' >&2; exit 1 ;;
esac
# Capture the full pair before any write. Blank or interrupted input aborts.
printf 'Enter %s (hidden): ' "$id_key" >&2
IFS= read -r -s client_id || { echo 'Installation cancelled: complete pair required.' >&2; exit 1; }
printf '\nEnter %s (hidden): ' "$secret_key" >&2
IFS= read -r -s client_secret || { echo 'Installation cancelled: complete pair required.' >&2; exit 1; }
printf '\n' >&2
if [[ -z "$client_id" || -z "$client_secret" ]]; then
  echo 'Installation cancelled: complete nonempty pair required.' >&2
  exit 1
fi
# The override lets tests substitute an explicit inert executable; never eval it.
runner="${PUBLISHING_SECRET_RUNNER:-npx}"
if ! printf '%s\0%s' "$client_id" "$client_secret" |
  node -e 'let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{const [id,secret]=input.split("\0");process.stdout.write(JSON.stringify({[process.argv[1]]:id,[process.argv[2]]:secret}));});' "$id_key" "$secret_key" |
  "$runner" --no-install wrangler@4.107.0 secret bulk --name divine-crossposter >/dev/null 2>&1; then
  unset client_id client_secret
  echo 'Credential installation failed. Check operator access before trying again.' >&2
  exit 1
fi
unset client_id client_secret
echo 'Selected credential pair installed. Provider flags and deployment are unchanged; OAuth acceptance still requires verification.'
