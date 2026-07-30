# signalk-notification-dispatcher

SignalK plugin: rule-based forwarding/suppression of other vessels'
notifications into `vessels.self.notifications.received.*`. Repo:
BoatHacks/signalk-notification-dispatcher. Considered a PoC/prototype for a
filtering-and-triggering ruleset rather than expected to play a major role in
the eventual Signal K notification/alert architecture (see the CAM RFC
discussion, [[signalk-cam-rfc]]).

## Design
- Reads `vessels.*.notifications.*`, forwards/filters rule-based into
  `vessels.self.notifications.received.*`.
- Rule config UI: custom Preact+htm webapp (not native SignalK plugin config
  schema), consistent with the other plugins.
- Severity mapping (settled): distress -> emergency, urgency -> alarm,
  safety -> warn. Transport sub-key format:
  `received.<severity>.<transport>-<uuid>`. `notifications.mob` kept as its
  own nature leaf for back-compat with existing MOB subscribers, not
  collapsed into `distress`.
- Ruleset structure: iptables-style `{ policy: 'ACCEPT'|'DROP', rules: [...] }`.
  Each rule has a `match` block (path/vessel/states/timebox/vesselState) and a
  `target`. Default policy (chain-level fallback) replaces the old hardcoded
  permit-all default, still defaults to ACCEPT. Persisted as `ruleset.json`
  with automatic one-time migration from the old flat `rules.json`.
- Rule targets: ACCEPT (forward), DROP (suppress), MODIFY (override
  notification state, e.g. warn->alert, while forwarding), ACTION (side
  effect: write to an arbitrary path via `delta`/`put`/`rest` mode,
  independently toggleable "Also forward").
- Match conditions: path pattern, notification state, source vessel/MMSI
  filter, timebox (`{enabled, times: ["HH:MM" UTC...], toleranceMinutes}`,
  also accepts 5-field crontab notation, handles midnight wraparound),
  vessel-state gating (`vesselStateGate: {blockWhenMoored, blockWhenAnchored}`,
  independent toggles), and `alwaysAcceptNormal` (also match a transition to
  nominal/normal regardless of the states list; a MODIFY rule bypasses its own
  override on that transition and forwards unmodified; DROP rules still drop).
- Target path template default: `notifications.received.{path}.dsc-{uuid}`.
  Supports `{vessel}/{path}/{uuid}` placeholders plus a "+ {uuid}" insert
  button in the editor.

## API and tooling
- REST: `/ruleset`, `/policy`, `/rules` CRUD, `/paths` (path picker backing
  data via `app.streambundle.getAvailablePaths()`). Full OpenAPI 3.0.3 spec at
  `docs/openApi.json` via `plugin.getOpenApi()`, same convention as
  [[signalk-stowage-mgmt]]/[[signalk-dead-mans-switch]].
- JSON import/export buttons and an in-webapp JSON ruleset editor.
- Formal JSON Schema (draft 2020-12) for the ruleset/rule shape at
  `docs/rules-schema.json`; `ajv` devDependency backs a schema-conformance
  test suite.
- `scripts/send-alert.sh`: dev tool injecting distress/urgency/safety
  notifications for an arbitrary vessel MMSI via the WebSocket delta stream
  (one-off or repeated, `--nature/--clear/--message/--token/--login` options),
  uses `ws` as a devDependency.
- Test suite: `node --test`, helpers in `test-support/` (outside `test/` so
  Node's default discovery doesn't run them). CI via SignalK's reusable
  plugin-ci.yml (Node 22/24, Linux/arm64/macOS/Windows/armv7).
- Vendored Preact/htm as a static bundle under `public/vendor/` (see the
  user-level webapp-conventions rule) — fixed a real bug where loading from
  unpkg.com blanked the whole app when offline.
- REST responses always set `Cache-Control: no-store`; webapp fetches use
  `cache:'no-store'` — GET responses were being cached after a mutation,
  hiding new/edited rules from the UI.
- Webapp `BASE` for fetches is hardcoded as the absolute path
  `/plugins/signalk-notification-dispatcher` per Signal K's documented
  convention (its own static files are served at `/<pluginId>/`, which is a
  genuinely different path from the API's `/plugins/<pluginId>/`, not just a
  trailing-slash variant — a location-derived BASE is fundamentally wrong
  here).
- Recent-activity log entries: collapsible `<details>` (collapsed by default)
  showing full JSON, existing summary line kept as the visible `<summary>`.
- Forwarded-path tracking: `forwardedTargetPaths` Map tracks the
  last-forwarded path per source notification (keyed by vessel context +
  subPath) so a repeated update and the eventual clear reuse the same path
  instead of a `{uuid}` template minting a fresh one that never matches.

## Open / unclear
- What "delete the targetPathTemplate property from filter rules" actually
  meant is still unclear — a removal was tried and reverted in the same
  session because it misunderstood the intent; needs clarifying next time it
  comes up.
