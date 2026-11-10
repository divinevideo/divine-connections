#!/usr/bin/env bash
# ABOUTME: Installs the crossposter secrets on the divine-crossposter worker, prompting for each.
# ABOUTME: Cloudflare secrets are write-only, so nothing here can be copied automatically.
set -euo pipefail

# Run this in your own terminal. Values are read with `read -s` so they are not
# echoed, and are piped straight into wrangler so they never reach your shell
# history or an agent transcript.

cd "$(dirname "$0")/.."

if [ ! -f wrangler.toml ]; then
  echo "error: run this from the divine-connections checkout" >&2
  exit 1
fi

echo "Installing secrets on the divine-crossposter worker."
echo "Press Enter to skip any secret you do not have yet — rerun this later for the rest."
echo "See docs/cutover-secrets.md for where each value comes from."
echo

installed=0
skipped=0

put_secret() {
  local name="$1"
  local hint="$2"
  local value=""

  printf '%s\n  %s\n  value (input hidden, Enter to skip): ' "$name" "$hint"
  read -rs value
  echo

  if [ -z "$value" ]; then
    echo "  skipped"
    echo
    skipped=$((skipped + 1))
    return
  fi

  printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null 2>&1
  echo "  installed"
  echo
  installed=$((installed + 1))
}

# Ordered by how much each unlocks. TOKEN_ENCRYPTION_KEY gates every OAuth
# path, so nothing else matters until it is set.
put_secret TOKEN_ENCRYPTION_KEY \
  "Leave blank to keep the current key. A different key makes every stored OAuth token unreadable. See docs/cutover-secrets.md."
put_secret TWITTER_CLIENT_ID       "X developer portal, OAuth 2.0 app. Unlocks connecting X."
put_secret TWITTER_CLIENT_SECRET   "X developer portal, OAuth 2.0 app."
put_secret INSTAGRAM_CLIENT_SECRET "Meta app dashboard. The client id is already a var in wrangler.toml."
put_secret TIKTOK_CLIENT_KEY       "TikTok developer portal, Login Kit. Unlocks connecting TikTok."
put_secret TIKTOK_CLIENT_SECRET    "TikTok developer portal, Login Kit."

echo "Installed ${installed}, skipped ${skipped}."
echo
echo "Currently set on the divine-crossposter worker:"
npx wrangler secret list

cat <<'NEXT'

Next:
  Each secret installed above deployed a new Worker version on its own.
  Releases still go through CI on merge to main; do not run wrangler deploy
  for production. ENABLE_TIKTOK / ENABLE_YOUTUBE in wrangler.toml still gate
  those two providers.

  Then visit https://crossposter.divine.video/platforms: each provider reports
  whether its flag and credentials are both set.
NEXT
