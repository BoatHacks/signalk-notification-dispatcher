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
  `MODIFY` (forward, overriding the notification's `state` first), or `DROP`
  (suppress).
- If **no rule matches**, the chain's default **policy** applies (`ACCEPT` or
  `DROP`, configurable in the webapp toolbar — defaults to `ACCEPT`, i.e.
  permit-all).

## Configuring rules

Open the plugin's webapp (SignalK admin UI → Webapps → Notification
Dispatcher). Each rule has:

| Field | Meaning |
|---|---|
| Label | Optional, just for your own reference |
| Path pattern | Matched against the notification path with `notifications.` stripped, e.g. `navigation.anchor*`. `*` matches anything. |
| Vessel filter | MMSI, full context string, or `*` for any vessel |
| States | Which notification states (`nominal`/`normal`/`alert`/`warn`/`alarm`/`emergency`) trigger the rule |
| Target | `ACCEPT` (forward), `MODIFY` (forward, overriding a field first), or `DROP` (suppress) |
| Override state to | Only for `MODIFY` rules. Rewrites the notification's `state` before forwarding, e.g. downgrading a recurring securité broadcast from `warn` to `alert` instead of dropping it outright. |
| Target path template | Only for `ACCEPT`/`MODIFY` rules. `{vessel}` and `{path}` placeholders. Default: `notifications.received.{vessel}.{path}` |
| Timebox | Optional. Restricts the rule to only match within a tolerance window (in minutes) around one or more UTC anchor times. Entries are semicolon-separated and can be either `HH:MM` (e.g. `02:15; 06:15; 10:15; 14:15; 18:15; 22:15 ±5m` for a coastal station's 4-hourly broadcasts) or, for expert use, a standard 5-field crontab expression (`minute hour dom month dow`, UTC), e.g. `15 2,6,10,14,18,22 * * *` for the same schedule, or `0 8 * * 0` for "every Sunday at 08:00". Disabled by default (rule matches at any time). |
| Skip while moored / Skip while anchored | Optional, independent toggles (either or both can be on). If the own vessel's `navigation.state` is currently `moored` and "skip while moored" is on (or `anchored` and "skip while anchored" is on), this rule is skipped as if it didn't match — evaluation falls through to the next rule, or to the default policy. |

A recent-activity log at the bottom of the webapp shows the last 200
accept/drop decisions, for debugging your rules.

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
        "states": ["alert"],
        "timebox": {
          "enabled": true,
          "times": ["02:15", "06:15", "10:15", "14:15", "18:15", "22:15"],
          "toleranceMinutes": 5
        },
        "vesselState": { "blockWhenMoored": false, "blockWhenAnchored": false }
      },
      "target": "DROP",
      "targetPathTemplate": "notifications.received.{vessel}.{path}",
      "modify": { "state": null }
    }
  ]
}
```

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

## License

MIT
