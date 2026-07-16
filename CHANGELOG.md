# Changelog

## [Unreleased]
- New `MODIFY` rule target: forwards a notification like `ACCEPT`, but first overrides its `state` (e.g. downgrading a recurring securité broadcast from `warn` to `alert` instead of dropping it outright)
- Fixed: added the `signalk-webapp` keyword to `package.json` so the webapp shows up under the SignalK admin UI's Webapps menu
- Test suite (`node --test`, no new dependencies): rule matching, default policy, timebox (HH:MM and crontab), vessel-state gating, `/rules` and `/ruleset` REST endpoints, `MODIFY` target, and legacy `rules.json` migration
- CI: `.github/workflows/ci.yml` calling the reusable SignalK `plugin-ci.yml` workflow (Node 22/24 across Linux, Linux arm64, macOS, Windows, and armv7 under QEMU)

## [0.1.0] - initial scaffold
- Subscribe to `vessels.*.notifications.*` across all contexts
- Rule engine modeled as an iptables-style ruleset: a chain-like ordered list of rules, each with a `match` block (path pattern, vessel/MMSI filter, notification states, optional timebox, optional vessel-state gate) and a `target` (`ACCEPT`/`DROP`), plus a chain-level default `policy` (`ACCEPT`/`DROP`, defaults to `ACCEPT`) applied when no rule matches
- Timebox match condition: restrict a rule to match only within +/- N minutes of one or more UTC anchor times (e.g. coastal station broadcast schedules); entries can also be standard 5-field crontab expressions (expert use), mixed freely with plain `HH:MM` entries in the same rule
- Vessel-state gating: per-rule "skip while moored" / "skip while anchored" toggles (independent, both can be enabled at once) based on the own vessel's `navigation.state`
- Ruleset persisted as `ruleset.json` in the plugin's data directory
- REST API: per-rule CRUD (`/rules`), whole-ruleset get/put (`/ruleset`) for import/export, default policy get/put (`/policy`), and `/activity`
- Buildless Preact + htm webapp: rule builder, JSON import/export, inline ruleset JSON editor (view/edit/validate/apply), recent-activity log
