# signalk-notification-dispatcher

A [SignalK](https://signalk.org) server plugin that watches notifications from
**other vessels** (`vessels.*.notifications.*` — AIS targets, buddy boats,
fleet members, etc.) and, based on a user-defined ruleset, either **accepts**
(forwards) them into `vessels.self.notifications.received.*` or **drops**
(suppresses) them.

Useful for surfacing relevant notifications from nearby vessels (e.g. anchor
alarms from a buddy boat) on your own MFD/dashboard, without being flooded by
every notification every AIS target ever raises.

## How it works

The ruleset is modeled like an iptables firewall chain:

- The plugin subscribes to `notifications.*` across all vessel contexts.
- Every incoming notification is checked against your **rules**, in order,
  **top to bottom** — the first matching rule decides the outcome.
- Each rule has a **match** (path pattern, vessel filter, states, optional
  timebox, optional vessel-state gate) and a **target**: `ACCEPT` (forward),
  `MODIFY` (forward, overriding the notification's `state` first), `ACTION`
  (write a value to an arbitrary path, call an arbitrary URL, optionally
  forwarding too), or `DROP` (suppress).
- If **no rule matches**, the chain's default **policy** applies (`ACCEPT` or
  `DROP`, configurable in the webapp toolbar — defaults to `ACCEPT`, i.e.
  permit-all).

### Clearing notifications

Per the Signal K spec, a notification is cleared by sending a `null` value
for its path, and the receiving server is expected to remove that key from
the tree entirely — not leave it sitting there with a null value.

The plugin tracks, per source notification, exactly which path it last
forwarded that notification to. When the source clears it, the clear is
sent to that *same* path — not a freshly-recomputed one. This matters in
particular for target path templates using `{uuid}`: without this
tracking, the clear would generate a brand new random path (since every
call to the template generates a fresh uuid), so it would never reach the
originally-forwarded copy, leaving it stuck forever while also creating an
unrelated, immediately-stray `null`-valued entry. The same tracking also
means repeated updates to a still-active notification land on the same
forwarded node instead of spawning a new one on every update; a fresh path
(and a fresh `{uuid}`, if the template uses one) is only generated for the
*next* occurrence, after the current one has been cleared.

## Configuring rules

Open the plugin's webapp (SignalK admin UI → Webapps → Notification
Dispatcher). Each rule has:

| Field | Meaning |
|---|---|
| Label | Optional, just for your own reference |
| Path pattern | Matched against the notification path with `notifications.` stripped, e.g. `navigation.anchor*`. `*` matches anything. |
| Vessel filter | MMSI, full context string, or `*` for any vessel |
| States | Which notification states (`nominal`/`normal`/`alert`/`warn`/`alarm`/`emergency`) trigger the rule. The editor shows the matching ITU priority category next to `emergency` (distress), `alarm` (urgency), and `warn` (safety), per the specification's recommended severity mapping. |
| Always accept state changes to nominal/normal | Optional. When on, this rule also matches a transition to `nominal` or `normal` regardless of the states checked above - useful for a rule narrowly scoped to e.g. `alarm`/`emergency` that should still catch the source returning to normal, without cluttering the main states filter. Other match conditions (path, vessel, timebox, vessel-state gate) still apply as usual. If the rule's target is `MODIFY`, a `nominal`/`normal` transition bypasses the override entirely and is forwarded via `ACCEPT` unmodified instead - a `DROP` target is unaffected and still drops. |
| Target | `ACCEPT` (forward), `MODIFY` (forward, overriding a field first), `ACTION` (write a value to an arbitrary path, or call an arbitrary URL), or `DROP` (suppress) |
| Write mode (`ACTION` only) | `delta` merges the value into the data model - the same mechanism `ACCEPT`/`MODIFY` use to forward, works for any Signal K path, but isn't a real command. `put` issues an actual PUT request against the own vessel - only works for paths with a registered put handler (e.g. switches), but is a real actuation. `rest` calls an arbitrary URL over HTTP - not scoped to Signal K at all, for calling out to other services (a Node-RED flow, a Home Assistant webhook, etc). |
| Path to write to / URL to call (`ACTION` only) | For `delta`/`put`: target Signal K path (own vessel), with an autocomplete/searchable dropdown (native `<datalist>`) populated from every path currently known to the server (`GET /paths`, backed by `app.streambundle.getAvailablePaths()`) - free text is also accepted, since the target path may not exist yet or may itself use placeholders. For `rest`: the full URL to call - no path autocomplete, since it isn't a Signal K path. |
| HTTP method (`ACTION` `rest` mode only) | `GET`, `POST`, or `PUT`. Defaults to `GET`. |
| Value to write / Request body (`ACTION` only) | For `delta`/`put`: the value to write. For `rest`: the request body sent for `POST`/`PUT` (ignored for `GET`). Plain text either way. May contain `{ref}` placeholders: `{vessel}`/`{path}`/`{uuid}` as usual, or a dot-path into the *triggering notification's own value* (e.g. `{state}`, `{status.isAcknowledged}`). A value that's entirely one placeholder keeps that reference's real type (so a boolean status flag stays a boolean); otherwise placeholders are stringified into the surrounding text. After resolution, a string result gets one extra `JSON.parse` pass as type coercion - `true`/`42`/`{"a":1}` become their real types, anything not valid JSON (e.g. `on`) stays a plain string. |
| Also forward (`ACTION` only) | Optional. Whether to *also* forward the notification via the normal target path template mechanism (same `{uuid}`-per-instance path reuse and clear-tracking as `ACCEPT`), in addition to the write/call. Independent of it - the write/call always happens (if a path/URL is set) regardless of this toggle. |
| Override state to | Only for `MODIFY` rules. Rewrites the notification's `state` before forwarding, e.g. downgrading a recurring securité broadcast from `alarm` to `warn` instead of dropping it outright. |
| Target path template | Only for `ACCEPT`/`MODIFY` rules, and `ACTION` rules with "Also forward" on. `{vessel}`, `{path}`, and `{uuid}` placeholders. Each `{uuid}` is replaced with a freshly-generated random UUID at forward time (a different value per occurrence, and per notification) - useful for disambiguating concurrent notifications, e.g. per the `<transport>-<uuid>` convention discussed for `received.<severity>.<key>` in the specification. Default: `notifications.received.{path}.dsc-{uuid}` |
| Timebox | Optional. Restricts the rule to only match within a tolerance window (in minutes) around one or more UTC anchor times. Entries are semicolon-separated and can be either `HH:MM` (e.g. `02:15; 06:15; 10:15; 14:15; 18:15; 22:15 ±5m` for a coastal station's 4-hourly broadcasts) or, for expert use, a standard 5-field crontab expression (`minute hour dom month dow`, UTC), e.g. `15 2,6,10,14,18,22 * * *` for the same schedule, or `0 8 * * 0` for "every Sunday at 08:00". Disabled by default (rule matches at any time). |
| Skip while moored / Skip while anchored | Optional, independent toggles (either or both can be on). If the own vessel's `navigation.state` is currently `moored` and "skip while moored" is on (or `anchored` and "skip while anchored" is on), this rule is skipped as if it didn't match — evaluation falls through to the next rule, or to the default policy. |

A recent-activity log at the bottom of the webapp shows the last 200
accept/drop/modify/action/clear decisions, for debugging your rules. Each
entry is collapsible and expands to the full JSON for that specific event.

### ACTION examples

Flash a physical anchor light switch (a real actuation) when an anchor
alarm fires, without forwarding the notification anywhere:

- Write mode: `put`
- Path to write to: `electrical.switches.anchorLight.state`
- Value to write: `true`
- Also forward: off

Mirror just the acknowledgement flag of a received urgency call into a
custom path, keyed by the notification's own path, while still forwarding
the notification normally:

- Write mode: `delta`
- Path to write to: `notifications.acknowledged.{path}`
- Value to write: `{status.isAcknowledged}`
- Also forward: on, with the usual target path template

Call an external webhook (e.g. a Node-RED flow or Home Assistant
automation) when a distress-priority notification comes in, posting a
small JSON payload:

- Write mode: `rest`
- HTTP method: `POST`
- URL to call: `http://homeassistant.local:8123/api/webhook/mayday-relay`
- Request body: `{"vessel":"{vessel}","message":"{message}"}`
- Also forward: off

`rest` mode has a 10-second timeout and isn't scoped to Signal K at all -
it'll call whatever URL you put in, on your local network or the wider
internet, with whatever credentials-free request you configure. Treat it
like any other outbound webhook: only point it at services you trust, and
don't rely on it for anything requiring authentication (there's no
credential/header configuration beyond a JSON `Content-Type` on
`POST`/`PUT`).

## Default policy

The toolbar has a **Default policy** selector (`ACCEPT` or `DROP`) — the
same concept as an iptables chain's default policy. It's what happens to a
notification that no rule matched. Defaults to `ACCEPT` (permit-all).

## Ruleset JSON — import, export, and direct editing

The full ruleset (`{ "policy": "ACCEPT" | "DROP", "rules": [...] }`) can be
managed as JSON directly from the webapp:

- **Export JSON** downloads the current ruleset as a `.json` file.
- **Import JSON** loads a `.json` file and replaces the current ruleset with
  it (validated: top-level object with a `rules` array).
- The **"Ruleset JSON editor"** panel shows the live ruleset as editable,
  pretty-printed JSON, with **Validate** (parses and checks shape without
  applying) and **Apply ruleset** (validates, then saves and reloads the
  rule table) buttons.

The full shape is formally described in
[`docs/rules-schema.json`](docs/rules-schema.json) (JSON Schema, draft
2020-12) — useful for validating a hand-edited ruleset before importing it,
or for editor autocomplete.

Example ruleset:

```json
{
  "policy": "ACCEPT",
  "rules": [
    {
      "id": "abc123",
      "label": "Squelch Palma Radio securité",
      "enabled": true,
      "match": {
        "path": "safety.*",
        "vessel": "*",
        "states": ["warn"],
        "timebox": {
          "enabled": true,
          "times": ["02:15", "06:15", "10:15", "14:15", "18:15", "22:15"],
          "toleranceMinutes": 5
        },
        "vesselState": { "blockWhenMoored": false, "blockWhenAnchored": false },
        "alwaysAcceptNormal": false
      },
      "target": "DROP",
      "targetPathTemplate": "notifications.received.{path}.dsc-{uuid}",
      "modify": { "state": null },
      "action": { "mode": "delta", "path": "", "value": "", "method": "GET", "forward": false }
    }
  ]
}
```

## REST API

Every endpoint the webapp uses (`/ruleset`, `/policy`, `/rules`, `/rules/{id}`,
`/activity`, `/paths`) is documented as an [OpenAPI 3.0.3](https://spec.openapis.org/oas/v3.0.3)
specification at [`openApi.json`](openApi.json), exposed via the plugin's
`getOpenApi()` method per Signal K's convention - it shows up in the server's
Admin UI under Documentation → OpenAPI, and can be fed to any standard
OpenAPI viewer/client generator. It's kept in sync with `docs/rules-schema.json`
by hand (the two serve different purposes: `docs/rules-schema.json` is a
standalone JSON Schema used by the webapp's own JSON editor for validation;
`openApi.json` additionally documents every request/response shape and error
case for API tooling) and is tested (`test/openapi.test.js`) to make sure its
`paths` match what `registerWithRouter` actually registers and every `$ref`
resolves.

## Development

```
npm install
```

The plugin has no runtime dependencies beyond Node's built-ins (the test
suite has devDependencies - `ajv` to validate rulesets against
`docs/rules-schema.json`, `jsdom` to smoke-test the webapp - neither is ever
required by the plugin itself). The webapp's own dependencies (Preact and
htm) are vendored as a static file under `public/vendor/` rather than
loaded from a CDN, so the webapp works with no internet access - see
`public/vendor/README.md` for why and how to update them. The ruleset
is persisted as JSON under the plugin's SignalK data directory
(`ruleset.json`), not in the plugin's own config schema, since it's managed
entirely through the webapp. A one-time migration runs automatically if an
older `rules.json` (pre-iptables-style, flat rule array) is found and no
`ruleset.json` exists yet.

### Testing

```
npm test
```

Runs the test suite with Node's built-in test runner (`node --test`).
Tests live in `test/` and cover rule matching (path/vessel/state/order),
the default policy, timebox conditions (both `HH:MM` and crontab
expert-mode entries), vessel-state gating, the `MODIFY` target, the
`/rules` and `/ruleset` REST endpoints, the legacy `rules.json` migration,
and a webapp smoke test (`test/webapp.test.js`) that actually executes the
webapp's real script against a `jsdom` document and confirms it renders -
this is what catches things like an unreachable CDN import silently
producing a blank page. Shared
test helpers (a fake SignalK `app`, a router-call shim) live in
`test-support/`, deliberately outside `test/` so Node's default test-file
discovery doesn't try to run them as tests themselves.

CI runs this suite via the reusable [SignalK plugin-ci
workflow](https://github.com/SignalK/signalk-server/blob/master/.github/workflows/plugin-ci.yml)
(`.github/workflows/ci.yml`), across Node 22/24 on Linux, Linux arm64, macOS,
Windows, and armv7 (Cerbo GX-class hardware) under QEMU.

### Dev tools

`scripts/send-alert.sh` injects a `distress`/`urgency`/`safety` notification
for an arbitrary vessel MMSI into a running SignalK server (via the
WebSocket delta stream - the same mechanism NMEA/AIS providers use to
report other vessels' data), so you can exercise this plugin's rules
without needing a real DSC/AIS distress relay. Requires `npm install` first
(uses `ws`, a devDependency). One-off by default, or repeated at an
interval:

```
scripts/send-alert.sh -c distress -m 211234567
scripts/send-alert.sh -c urgency -m 211234567 -i 30 -N 5 -M "PAN PAN: vessel adrift"
scripts/send-alert.sh -c safety -m 224123456 -n notice-to-mariners
scripts/send-alert.sh -c distress -m 211234567 --clear
scripts/send-alert.sh -c distress -m 211234567 -l alerts-bot:hunter2
```

Run with `-h`/`--help` for the full option list. The category-to-state
mapping matches the specification's recommended severity mapping
(`distress`→`emergency`, `urgency`→`alarm`, `safety`→`warn`).

For a security-enabled server, authenticate with either `--token <token>`
(e.g. one minted via SignalK server's `signalk-generate-token` CLI against
a dedicated user account) or `--login <username>:<password>` to have the
script log in and obtain a token itself. Neither is needed if the server
has security disabled.

## License

MIT
