# Changelog

## [Unreleased]
- Rule editor: the "Notification states to match" checkboxes now show the matching ITU priority category next to `emergency` (distress), `alarm` (urgency), and `warn` (safety)
- Target path template now supports a `{uuid}` placeholder (alongside `{vessel}`/`{path}`), replaced with a freshly-generated random UUID per occurrence at forward time - useful for disambiguating concurrent notifications; the rule editor has a "+ {uuid}" button to insert it
- **Fixed: webapp showed a blank page with no internet access.** The webapp loaded Preact and htm from `unpkg.com` at runtime; since ES module imports all resolve before any code runs, one unreachable CDN import silently aborted the entire script - on a boat, whose browser very often only has access to the local SignalK server, this meant the webapp never rendered at all, with no visible error. Preact/htm are now vendored as a single self-contained file under `public/vendor/` (see `public/vendor/README.md`), so the webapp works fully offline. Added `test/webapp.test.js`, which actually executes the webapp's script against a `jsdom` document and confirms it renders, plus checks that no import is a CDN URL - this class of failure won't get merged again silently
- Exported the ruleset/rule shape as a formal JSON Schema (draft 2020-12) at `docs/rules-schema.json`, useful for validating a hand-edited ruleset before import or for editor autocomplete; added `test/schema.test.js` (using `ajv` as a devDependency) to keep it honest against real plugin output
- New `MODIFY` rule target: forwards a notification like `ACCEPT`, but first overrides its `state` (e.g. downgrading a recurring securité broadcast from `alarm` to `warn` instead of dropping it outright)
- Fixed: added the `signalk-webapp` keyword to `package.json` so the webapp shows up under the SignalK admin UI's Webapps menu
- Test suite (`node --test`): rule matching, default policy, timebox (HH:MM and crontab), vessel-state gating, `/rules` and `/ruleset` REST endpoints, `MODIFY` target, legacy `rules.json` migration, and a webapp render smoke test (`jsdom` as a devDependency)
- CI: `.github/workflows/ci.yml` calling the reusable SignalK `plugin-ci.yml` workflow (Node 22/24 across Linux, Linux arm64, macOS, Windows, and armv7 under QEMU)

## [0.1.0] - initial scaffold
- Subscribe to `vessels.*.notifications.*` across all contexts
- Rule engine modeled as an iptables-style ruleset: a chain-like ordered list of rules, each with a `match` block (path pattern, vessel/MMSI filter, notification states, optional timebox, optional vessel-state gate) and a `target` (`ACCEPT`/`DROP`), plus a chain-level default `policy` (`ACCEPT`/`DROP`, defaults to `ACCEPT`) applied when no rule matches
- Timebox match condition: restrict a rule to match only within +/- N minutes of one or more UTC anchor times (e.g. coastal station broadcast schedules); entries can also be standard 5-field crontab expressions (expert use), mixed freely with plain `HH:MM` entries in the same rule
- Vessel-state gating: per-rule "skip while moored" / "skip while anchored" toggles (independent, both can be enabled at once) based on the own vessel's `navigation.state`
- Ruleset persisted as `ruleset.json` in the plugin's data directory
- REST API: per-rule CRUD (`/rules`), whole-ruleset get/put (`/ruleset`) for import/export, default policy get/put (`/policy`), and `/activity`
- Buildless Preact + htm webapp: rule builder, JSON import/export, inline ruleset JSON editor (view/edit/validate/apply), recent-activity log
