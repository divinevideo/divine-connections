#!/usr/bin/env bash
# ABOUTME: Installs the secrets divine-connections needs, prompting for each value.
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

echo "Installing secrets on divine-connections."
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
  "MUST match the crossposter worker's while both run against the shared D1. See docs/cutover-secrets.md."
put_secret TWITTER_CLIENT_ID       "X developer portal, OAuth 2.0 app. Unlocks X Quick Connect."
put_secret TWITTER_CLIENT_SECRET   "X developer portal, OAuth 2.0 app."
put_secret INSTAGRAM_CLIENT_SECRET "Meta app dashboard. The client id is already a var in wrangler.toml."
put_secret DISCORD_BOT_TOKEN       "Discord developer portal — reset it, nobody holds a copy. Unlocks Discord verification."
put_secret TIKTOK_CLIENT_KEY       "TikTok developer portal, Login Kit. Unlocks TikTok Quick Connect."
put_secret TIKTOK_CLIENT_SECRET    "TikTok developer portal, Login Kit."
put_secret YOUTUBE_API_KEY         "Google Cloud console. Unlocks YouTube proof verification."

echo "Installed ${installed}, skipped ${skipped}."
echo
echo "Currently set on divine-connections:"
npx wrangler secret list

cat <<'NEXT'

Next:
  npx wrangler deploy       # ENABLE_TIKTOK / ENABLE_YOUTUBE in wrangler.toml
                            # still gate those two providers
  npm run test:e2e          # capability + Quick Connect assertions name any
                            # secret still missing
NEXT
