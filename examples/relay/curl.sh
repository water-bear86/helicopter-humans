#!/bin/sh
# Call the local prototype relay with curl. Start it first: npm run relay
# The token is read from the file the relay wrote; it is never passed on the command line.
set -eu
RELAY="${RELAY_URL:-http://127.0.0.1:8749}"
TOKEN_FILE="${RELAY_TOKEN_FILE:-.relay-local/token}"

curl -sS "$RELAY/v1/status"
echo
# curl reads the header from stdin (-H @-), so the token does not appear in the process list.
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" | curl -sS -H @- "$RELAY/v1/hn/item/8863"
echo
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" | curl -sS -H @- "$RELAY/v1/hn/maxitem"
echo
