#!/usr/bin/env bash
#
# send-alert.sh - Inject a distress/urgency/safety notification for an
# arbitrary vessel (by MMSI) into a running SignalK server, via the
# Signal K WebSocket delta stream (/signalk/v1/stream). Useful for
# exercising signalk-notification-dispatcher's rules without needing a
# real DSC/AIS distress relay.
#
# Deltas for a context other than the server's own vessel (i.e. "another
# vessel is calling") are injected over the WebSocket stream, not the REST
# API - the REST API's PUT mechanism is for self/PUT-handler paths (like
# switches), not for raising notifications on other vessels' behalf. This
# is the same mechanism NMEA/AIS providers use to report other vessels'
# data into the Signal K tree.
#
# Usage:
#   scripts/send-alert.sh -c distress -m 211234567
#   scripts/send-alert.sh -c urgency -m 211234567 -M "PAN PAN: vessel adrift"
#   scripts/send-alert.sh -c safety -m 224123456 -i 30 -N 5
#   scripts/send-alert.sh -c distress -m 211234567 -n mob
#   scripts/send-alert.sh -c distress -m 211234567 --clear
#
# Run with -h/--help for the full option list.

set -euo pipefail

# ---- defaults --------------------------------------------------------

HOST="localhost"
PORT="3000"
USE_SSL=0
TOKEN=""
CATEGORY=""
MMSI=""
MESSAGE=""
NATURE=""
INTERVAL=""
COUNT=""
SOURCE_LABEL="send-alert.sh"
METHOD="visual,sound"
CLEAR=0

usage() {
  cat <<'USAGE'
Send a distress/urgency/safety notification for an arbitrary vessel MMSI
into SignalK, via the WebSocket delta stream. One-off by default, or
repeated at a fixed interval.

Usage:
  send-alert.sh -c <category> -m <mmsi> [options]

Required:
  -c, --category <distress|urgency|safety>
                          ITU priority category to send. Mapped to the
                          notification state per the specification's
                          recommended severity mapping:
                            distress -> emergency
                            urgency  -> alarm
                            safety   -> warn

  -m, --mmsi <mmsi>       Target vessel's MMSI. The notification is raised
                          at vessels.urn:mrn:imo:mmsi:<mmsi>.notifications.*

Options:
  -H, --host <host>       SignalK server host (default: localhost)
  -p, --port <port>       SignalK server port (default: 3000)
      --ssl               Use wss:// instead of ws://
  -t, --token <token>     Bearer token, for a security-enabled server
  -M, --message <text>    Notification message. Defaults to a canned
                          message for the chosen category.
  -n, --nature <nature>   Nest the notification under this nature, e.g.
                          "mob" sends to notifications.<category>.mob
                          instead of the flat notifications.<category>.
  -s, --source <label>    $source label to tag the delta with
                          (default: send-alert.sh)
      --method <list>     Comma-separated notification method(s), e.g.
                          "visual" or "visual,sound" (default: visual,sound)
  -i, --interval <secs>   Repeat every <secs> seconds instead of sending
                          once. Ctrl+C to stop.
  -N, --count <n>         With --interval, stop after <n> sends (default:
                          unlimited - runs until interrupted)
      --clear             Send a null value to clear the notification
                          instead of raising it (method/message ignored)
  -h, --help              Show this help and exit

Examples:
  # One-off mayday for MMSI 211234567
  send-alert.sh -c distress -m 211234567

  # Repeat a pan-pan every 30s, 5 times, with a custom message
  send-alert.sh -c urgency -m 211234567 -i 30 -N 5 -M "PAN PAN: vessel adrift"

  # A securite broadcast nested under a specific nature
  send-alert.sh -c safety -m 224123456 -n notice-to-mariners

  # Clear a previously-raised distress notification
  send-alert.sh -c distress -m 211234567 --clear
USAGE
}

# ---- arg parsing -------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    -c|--category) CATEGORY="$2"; shift 2 ;;
    -m|--mmsi) MMSI="$2"; shift 2 ;;
    -H|--host) HOST="$2"; shift 2 ;;
    -p|--port) PORT="$2"; shift 2 ;;
    --ssl) USE_SSL=1; shift ;;
    -t|--token) TOKEN="$2"; shift 2 ;;
    -M|--message) MESSAGE="$2"; shift 2 ;;
    -n|--nature) NATURE="$2"; shift 2 ;;
    -s|--source) SOURCE_LABEL="$2"; shift 2 ;;
    --method) METHOD="$2"; shift 2 ;;
    -i|--interval) INTERVAL="$2"; shift 2 ;;
    -N|--count) COUNT="$2"; shift 2 ;;
    --clear) CLEAR=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ -z "$CATEGORY" ] || [ -z "$MMSI" ]; then
  echo "Error: --category and --mmsi are required." >&2
  usage >&2
  exit 1
fi

case "$CATEGORY" in
  distress|urgency|safety) ;;
  *) echo "Error: --category must be one of: distress, urgency, safety" >&2; exit 1 ;;
esac

if ! [[ "$MMSI" =~ ^[0-9]{9}$ ]]; then
  echo "Warning: MMSI '$MMSI' doesn't look like a 9-digit MMSI - continuing anyway." >&2
fi

if [ -n "$INTERVAL" ] && ! [[ "$INTERVAL" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "Error: --interval must be a positive number of seconds." >&2
  exit 1
fi

if [ -n "$COUNT" ] && [ -z "$INTERVAL" ]; then
  echo "Error: --count only makes sense together with --interval." >&2
  exit 1
fi

# ---- locate the repo root, so `require('ws')` resolves regardless of cwd ----

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! NODE_PATH="$REPO_ROOT/node_modules" node -e "require('ws')" >/dev/null 2>&1; then
  echo "Error: the 'ws' package isn't installed. Run 'npm install' in $REPO_ROOT first." >&2
  exit 1
fi

# ---- hand off to node for the actual WebSocket work ---------------------

SEND_ALERT_HOST="$HOST" \
SEND_ALERT_PORT="$PORT" \
SEND_ALERT_SSL="$USE_SSL" \
SEND_ALERT_TOKEN="$TOKEN" \
SEND_ALERT_CATEGORY="$CATEGORY" \
SEND_ALERT_MMSI="$MMSI" \
SEND_ALERT_MESSAGE="$MESSAGE" \
SEND_ALERT_NATURE="$NATURE" \
SEND_ALERT_SOURCE="$SOURCE_LABEL" \
SEND_ALERT_METHOD="$METHOD" \
SEND_ALERT_INTERVAL="$INTERVAL" \
SEND_ALERT_COUNT="$COUNT" \
SEND_ALERT_CLEAR="$CLEAR" \
NODE_PATH="$REPO_ROOT/node_modules" \
node <<'NODE_EOF'
const WebSocket = require('ws')

const {
  SEND_ALERT_HOST: host,
  SEND_ALERT_PORT: port,
  SEND_ALERT_SSL: useSsl,
  SEND_ALERT_TOKEN: token,
  SEND_ALERT_CATEGORY: category,
  SEND_ALERT_MMSI: mmsi,
  SEND_ALERT_MESSAGE: messageArg,
  SEND_ALERT_NATURE: nature,
  SEND_ALERT_SOURCE: sourceLabel,
  SEND_ALERT_METHOD: methodArg,
  SEND_ALERT_INTERVAL: intervalArg,
  SEND_ALERT_COUNT: countArg,
  SEND_ALERT_CLEAR: clearArg,
} = process.env

// Recommended severity mapping per the specification's ITU priority
// categories (distress/urgency/safety well-known notification names).
const STATE_BY_CATEGORY = { distress: 'emergency', urgency: 'alarm', safety: 'warn' }

const DEFAULT_MESSAGE_BY_CATEGORY = {
  distress: 'MAYDAY MAYDAY MAYDAY - test distress call',
  urgency: 'PAN PAN PAN PAN - test urgency call',
  safety: 'SECURITE SECURITE - test safety broadcast',
}

const clear = clearArg === '1'
const path = nature ? `notifications.${category}.${nature}` : `notifications.${category}`
const message = messageArg || DEFAULT_MESSAGE_BY_CATEGORY[category]
const method = methodArg.split(',').map((m) => m.trim()).filter(Boolean)
const interval = intervalArg ? Number(intervalArg) * 1000 : null
const count = countArg ? Number(countArg) : Infinity

function buildDelta() {
  const value = clear
    ? null
    : {
        state: STATE_BY_CATEGORY[category],
        method,
        message,
      }

  return {
    context: `vessels.urn:mrn:imo:mmsi:${mmsi}`,
    updates: [
      {
        source: { label: sourceLabel },
        timestamp: new Date().toISOString(),
        values: [{ path, value }],
      },
    ],
  }
}

const protocol = useSsl === '1' ? 'wss' : 'ws'
const url = `${protocol}://${host}:${port}/signalk/v1/stream?subscribe=none`
const wsOptions = {}
if (token) wsOptions.headers = { Authorization: `Bearer ${token}` }

const ws = new WebSocket(url, wsOptions)
let sent = 0
let timer = null

function describeAndSend() {
  const delta = buildDelta()
  ws.send(JSON.stringify(delta))
  sent += 1
  const verb = clear ? 'Cleared' : 'Sent'
  console.log(`${verb} ${category} (${clear ? 'null' : STATE_BY_CATEGORY[category]}) -> vessels.urn:mrn:imo:mmsi:${mmsi}.${path} [${sent}${count === Infinity ? '' : `/${count}`}]`)

  if (sent >= count) {
    if (timer) clearInterval(timer)
    ws.close()
  }
}

ws.on('open', () => {
  describeAndSend()
  if (interval && sent < count) {
    timer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) describeAndSend()
    }, interval)
  } else {
    ws.close()
  }
})

ws.on('error', (err) => {
  console.error(`WebSocket error: ${err.message}`)
  process.exit(1)
})

ws.on('close', () => {
  if (!interval || sent >= count) process.exit(0)
})

process.on('SIGINT', () => {
  if (timer) clearInterval(timer)
  ws.close()
  process.exit(0)
})
NODE_EOF
