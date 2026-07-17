const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ALL_STATES = ['nominal', 'normal', 'alert', 'warn', 'alarm', 'emergency']
const MAX_ACTIVITY_LOG = 200
const DEFAULT_TARGET_PATH_TEMPLATE = 'notifications.received.{vessel}.{path}'

module.exports = function (app) {
  let unsubscribes = []
  let activityLog = []
  let rulesetFilePath = null

  // The ruleset mirrors an iptables-style firewall chain:
  //   - `policy` is the default target (ACCEPT|DROP) applied when no rule matches
  //   - `rules` is an ordered list, evaluated top to bottom, first match wins
  // Each rule has a `match` block (the conditions) and a `target` (the action:
  // ACCEPT = forward, DROP = suppress), plus a targetPathTemplate for ACCEPT.
  let ruleset = { policy: 'ACCEPT', rules: [] }

  const plugin = {
    id: 'signalk-notification-dispatcher',
    name: 'Notification Dispatcher',
    description:
      'Forwards or suppresses notifications from other vessels into vessels.self.notifications.received.* based on an iptables-style ruleset',
  }

  // ---- rule shape helpers --------------------------------------------------

  function defaultMatch() {
    return {
      path: '*',
      vessel: '*',
      states: ['alert', 'warn', 'alarm', 'emergency'],
      timebox: { enabled: false, times: [], toleranceMinutes: 5 },
      vesselState: { blockWhenMoored: false, blockWhenAnchored: false },
    }
  }

  function newRuleId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  }

  // Fills in any missing pieces of a (possibly partial/hand-edited) rule with
  // sane defaults, so both the "+ Add rule" flow and JSON import are tolerant
  // of partial input. Existing values are always preserved.
  function sanitizeRule(input) {
    const src = input && typeof input === 'object' ? input : {}
    const match = src.match && typeof src.match === 'object' ? src.match : {}
    const dm = defaultMatch()

    return {
      id: typeof src.id === 'string' && src.id ? src.id : newRuleId(),
      enabled: src.enabled !== false,
      label: typeof src.label === 'string' ? src.label : '',
      match: {
        path: typeof match.path === 'string' ? match.path : dm.path,
        vessel: typeof match.vessel === 'string' ? match.vessel : dm.vessel,
        states: Array.isArray(match.states) ? match.states : dm.states,
        timebox: {
          enabled: !!(match.timebox && match.timebox.enabled),
          times: match.timebox && Array.isArray(match.timebox.times) ? match.timebox.times : [],
          toleranceMinutes:
            match.timebox && Number.isFinite(match.timebox.toleranceMinutes)
              ? match.timebox.toleranceMinutes
              : 5,
        },
        vesselState: {
          blockWhenMoored: !!(match.vesselState && match.vesselState.blockWhenMoored),
          blockWhenAnchored: !!(match.vesselState && match.vesselState.blockWhenAnchored),
        },
      },
      target: src.target === 'DROP' ? 'DROP' : src.target === 'MODIFY' ? 'MODIFY' : 'ACCEPT',
      targetPathTemplate:
        typeof src.targetPathTemplate === 'string' ? src.targetPathTemplate : DEFAULT_TARGET_PATH_TEMPLATE,
      // Only meaningful when target === 'MODIFY': overrides the notification's
      // own fields while forwarding it. Currently supports overriding `state`
      // (e.g. downgrading a recurring securité call from alarm to warn
      // instead of dropping it outright) - extend here if more fields need
      // to be modifiable later.
      modify: {
        state: ALL_STATES.includes(src.modify && src.modify.state) ? src.modify.state : null,
      },
    }
  }

  function sanitizeRuleset(input) {
    const src = input && typeof input === 'object' ? input : {}
    return {
      policy: src.policy === 'DROP' ? 'DROP' : 'ACCEPT',
      rules: Array.isArray(src.rules) ? src.rules.map(sanitizeRule) : [],
    }
  }

  // Converts a pre-iptables-style flat rule (pathPattern/vesselFilter/action/
  // vesselStateGate at the top level) into the new match/target shape.
  function migrateLegacyRule(old) {
    return sanitizeRule({
      id: old.id,
      enabled: old.enabled,
      label: old.label,
      target: old.action === 'suppress' ? 'DROP' : 'ACCEPT',
      targetPathTemplate: old.targetPathTemplate,
      match: {
        path: old.pathPattern,
        vessel: old.vesselFilter,
        states: old.states,
        timebox: old.timebox,
        vesselState: old.vesselStateGate,
      },
    })
  }

  // ---- persistence -------------------------------------------------------

  function loadRuleset() {
    const dataDir = app.getDataDirPath()
    rulesetFilePath = path.join(dataDir, 'ruleset.json')

    try {
      const raw = fs.readFileSync(rulesetFilePath, 'utf8')
      ruleset = sanitizeRuleset(JSON.parse(raw))
      return
    } catch (err) {
      // fall through to legacy migration / empty default below
    }

    // One-time migration from the pre-iptables-style rules.json, if present.
    try {
      const legacyPath = path.join(dataDir, 'rules.json')
      const raw = fs.readFileSync(legacyPath, 'utf8')
      const legacyRules = JSON.parse(raw)
      if (Array.isArray(legacyRules)) {
        ruleset = { policy: 'ACCEPT', rules: legacyRules.map(migrateLegacyRule) }
        saveRuleset()
        return
      }
    } catch (err) {
      // no legacy file either; start fresh
    }

    ruleset = { policy: 'ACCEPT', rules: [] }
  }

  function saveRuleset() {
    try {
      fs.writeFileSync(rulesetFilePath, JSON.stringify(ruleset, null, 2))
    } catch (err) {
      app.error(`Failed to save ruleset.json: ${err.message}`)
    }
  }

  function logActivity(entry) {
    activityLog.unshift({ ...entry, timestamp: new Date().toISOString() })
    if (activityLog.length > MAX_ACTIVITY_LOG) {
      activityLog.length = MAX_ACTIVITY_LOG
    }
  }

  function statusMessage() {
    return `Policy: ${ruleset.policy}, ${ruleset.rules.length} rule(s) loaded`
  }

  // ---- matching helpers ---------------------------------------------------

  // Turns a simple '*'-wildcard pattern into a RegExp. '*' matches any run of
  // characters (including '.'). An empty/undefined pattern or the literal
  // '*' matches everything.
  function globToRegExp(glob) {
    if (!glob || glob === '*') return /^.*$/
    const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`)
  }

  function extractVesselLabel(context) {
    // context looks like "vessels.urn:mrn:imo:mmsi:123456789" or
    // "vessels.urn:mrn:signalk:uuid:...". Prefer a bare MMSI when present.
    const mmsiMatch = context.match(/mmsi:(\d+)/)
    if (mmsiMatch) return mmsiMatch[1]
    return context.replace(/^vessels\./, '').replace(/[^a-zA-Z0-9]+/g, '_')
  }

  // A timebox restricts a rule to only match within +/- toleranceMinutes of
  // one or more UTC anchor times. Used for things like "only match around
  // the coastal station's 4-hourly broadcast times". A rule with no timebox
  // (or an empty/disabled one) always matches, time-wise.
  //
  // Each entry in timebox.times is either:
  //   - a simple "HH:MM" UTC anchor time, or
  //   - a standard 5-field crontab expression ("min hour dom month dow", UTC)
  //     for expert use, e.g. "15 2,6,10,14,18,22 * * *"
  // A whitespace-containing entry is treated as a cron expression.

  function isCronExpr(entry) {
    return String(entry).trim().split(/\s+/).length === 5
  }

  // Matches a single cron field ("*", "5", "1,3,5", "1-5", "*/15", "1-10/2")
  // against a value within [min, max].
  function matchesCronField(fieldSpec, value, min, max) {
    return fieldSpec.split(',').some((part) => {
      let range = part
      let step = 1
      if (part.includes('/')) {
        const [r, s] = part.split('/')
        range = r
        step = parseInt(s, 10) || 1
      }
      let lo, hi
      if (range === '*') {
        lo = min
        hi = max
      } else if (range.includes('-')) {
        const [a, b] = range.split('-').map(Number)
        lo = a
        hi = b
      } else {
        const n = Number(range)
        if (Number.isNaN(n)) return false
        lo = hi = n
      }
      if (value < lo || value > hi) return false
      return (value - lo) % step === 0
    })
  }

  function matchesCron(cronExpr, date) {
    const fields = cronExpr.trim().split(/\s+/)
    if (fields.length !== 5) return false
    const [minute, hour, dom, month, dow] = fields
    return (
      matchesCronField(minute, date.getUTCMinutes(), 0, 59) &&
      matchesCronField(hour, date.getUTCHours(), 0, 23) &&
      matchesCronField(dom, date.getUTCDate(), 1, 31) &&
      matchesCronField(month, date.getUTCMonth() + 1, 1, 12) &&
      matchesCronField(dow, date.getUTCDay(), 0, 6)
    )
  }

  function isWithinTimebox(timebox, date) {
    if (!timebox || !timebox.enabled) return true
    const anchors = (timebox.times || []).filter(Boolean)
    if (anchors.length === 0) return true

    const tolerance = Number.isFinite(timebox.toleranceMinutes) ? timebox.toleranceMinutes : 5

    return anchors.some((entry) => {
      const raw = String(entry).trim()

      if (isCronExpr(raw)) {
        // A cron schedule doesn't have one fixed "anchor" to diff against, so
        // scan every minute within +/- tolerance of "now" for a match.
        for (let offset = -tolerance; offset <= tolerance; offset++) {
          const candidate = new Date(date.getTime() + offset * 60000)
          if (matchesCron(raw, candidate)) return true
        }
        return false
      }

      const m = raw.match(/^(\d{1,2}):(\d{2})$/)
      if (!m) return false
      const anchorMinutes = parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
      const minutesNow = date.getUTCHours() * 60 + date.getUTCMinutes()
      const rawDiff = Math.abs(minutesNow - anchorMinutes)
      const diff = Math.min(rawDiff, 1440 - rawDiff) // handle wraparound across midnight
      return diff <= tolerance
    })
  }

  // Reads the own vessel's current navigation.state (e.g. "anchored",
  // "moored", "motoring", ...). Returns null if unset/unknown.
  function getOwnNavigationState() {
    const raw = app.getSelfPath('navigation.state')
    if (raw === undefined || raw === null) return null
    if (typeof raw === 'object' && 'value' in raw) return raw.value
    return raw
  }

  // Per-rule gate: "don't match while the own vessel is moored/anchored".
  // Two independent toggles, either or both can be enabled on a rule.
  function isBlockedByVesselState(vesselState, ownNavState) {
    if (!vesselState) return false
    if (vesselState.blockWhenMoored && ownNavState === 'moored') return true
    if (vesselState.blockWhenAnchored && ownNavState === 'anchored') return true
    return false
  }

  function matchesRule(rule, { subPath, context, vesselLabel, state, timestamp, ownNavState }) {
    if (rule.enabled === false) return false

    const match = rule.match || {}

    if (!globToRegExp(match.path).test(subPath)) return false

    const vesselFilter = match.vessel || '*'
    const vesselOk =
      globToRegExp(vesselFilter).test(context) ||
      globToRegExp(vesselFilter).test(vesselLabel)
    if (!vesselOk) return false

    const states = match.states === undefined || match.states === null ? ALL_STATES : match.states
    if (!states.includes(state)) return false

    if (!isWithinTimebox(match.timebox, timestamp)) return false

    if (isBlockedByVesselState(match.vesselState, ownNavState)) return false

    return true
  }

  function buildTargetPath(rule, { subPath, vesselLabel }) {
    const template = rule.targetPathTemplate || DEFAULT_TARGET_PATH_TEMPLATE
    return template
      .replaceAll('{vessel}', vesselLabel)
      .replaceAll('{path}', subPath)
      .replaceAll('{uuid}', () => crypto.randomUUID())
  }

  // ---- delta handling ------------------------------------------------------

  function handleDelta(delta) {
    const context = delta.context
    if (!context || context === app.selfContext) return // ignore our own vessel

    const vesselLabel = extractVesselLabel(context)
    const ownNavState = getOwnNavigationState()

    ;(delta.updates || []).forEach((update) => {
      const timestamp = update.timestamp ? new Date(update.timestamp) : new Date()

      ;(update.values || []).forEach(({ path: valuePath, value }) => {
        if (!valuePath || !valuePath.startsWith('notifications.')) return
        const subPath = valuePath.slice('notifications.'.length)
        const state = value && value.state ? value.state : 'normal'

        const matchInfo = { subPath, context, vesselLabel, state, timestamp, ownNavState }
        const matchedRule = ruleset.rules.find((rule) => matchesRule(rule, matchInfo))

        // Fall back to the chain's default policy (ACCEPT/DROP) when no rule
        // matches - mirroring an iptables chain's default policy.
        const effectiveRule = matchedRule || {
          id: 'default-policy',
          label: `default policy (${ruleset.policy})`,
          target: ruleset.policy,
          targetPathTemplate: DEFAULT_TARGET_PATH_TEMPLATE,
        }

        if (effectiveRule.target === 'DROP') {
          logActivity({
            action: 'drop',
            rule: effectiveRule.label || effectiveRule.id,
            sourcePath: valuePath,
            vessel: vesselLabel,
            state,
          })
          return
        }

        const isModify = effectiveRule.target === 'MODIFY' && effectiveRule.modify && effectiveRule.modify.state
        const outValue = isModify ? { ...value, state: effectiveRule.modify.state } : value

        const targetPath = buildTargetPath(effectiveRule, { subPath, vesselLabel })
        app.handleMessage(plugin.id, {
          updates: [
            {
              values: [
                {
                  path: targetPath,
                  value: outValue,
                },
              ],
            },
          ],
        })

        logActivity({
          action: isModify ? 'modify' : 'accept',
          rule: effectiveRule.label || effectiveRule.id,
          sourcePath: valuePath,
          targetPath,
          vessel: vesselLabel,
          state: isModify ? `${state}→${effectiveRule.modify.state}` : state,
        })
      })
    })
  }

  // ---- plugin lifecycle ----------------------------------------------------

  plugin.start = function (options) {
    loadRuleset()
    app.subscriptionmanager.subscribe(
      { context: '*', subscribe: [{ path: 'notifications.*', policy: 'instant' }] },
      unsubscribes,
      (err) => app.error(`Subscription error: ${err}`),
      handleDelta
    )
    app.setPluginStatus(statusMessage())
  }

  plugin.stop = function () {
    unsubscribes.forEach((f) => f())
    unsubscribes = []
  }

  plugin.schema = {
    type: 'object',
    properties: {},
  }

  // ---- REST API for the rule-builder webapp --------------------------------

  plugin.registerWithRouter = function (router) {
    // Whole-ruleset endpoints: used by the JSON editor and import/export.
    router.get('/ruleset', (req, res) => {
      res.json(ruleset)
    })

    router.put('/ruleset', (req, res) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ error: 'Expected a ruleset object with "policy" and "rules"' })
      }
      if (req.body.rules !== undefined && !Array.isArray(req.body.rules)) {
        return res.status(400).json({ error: '"rules" must be an array' })
      }
      ruleset = sanitizeRuleset(req.body)
      saveRuleset()
      app.setPluginStatus(statusMessage())
      res.json(ruleset)
    })

    // Default policy only.
    router.get('/policy', (req, res) => {
      res.json({ policy: ruleset.policy })
    })

    router.put('/policy', (req, res) => {
      if (req.body?.policy !== 'ACCEPT' && req.body?.policy !== 'DROP') {
        return res.status(400).json({ error: 'policy must be "ACCEPT" or "DROP"' })
      }
      ruleset.policy = req.body.policy
      saveRuleset()
      app.setPluginStatus(statusMessage())
      res.json({ policy: ruleset.policy })
    })

    // Per-rule CRUD, operating on ruleset.rules (table-driven editing).
    router.get('/rules', (req, res) => {
      res.json(ruleset.rules)
    })

    router.post('/rules', (req, res) => {
      const rule = sanitizeRule({ ...req.body, id: undefined })
      ruleset.rules.push(rule)
      saveRuleset()
      app.setPluginStatus(statusMessage())
      res.json(rule)
    })

    router.put('/rules/:id', (req, res) => {
      const idx = ruleset.rules.findIndex((r) => r.id === req.params.id)
      if (idx === -1) return res.status(404).json({ error: 'Rule not found' })
      const merged = {
        ...ruleset.rules[idx],
        ...req.body,
        id: ruleset.rules[idx].id,
        match: { ...ruleset.rules[idx].match, ...(req.body && req.body.match) },
      }
      ruleset.rules[idx] = sanitizeRule(merged)
      saveRuleset()
      res.json(ruleset.rules[idx])
    })

    router.delete('/rules/:id', (req, res) => {
      const idx = ruleset.rules.findIndex((r) => r.id === req.params.id)
      if (idx === -1) return res.status(404).json({ error: 'Rule not found' })
      const [removed] = ruleset.rules.splice(idx, 1)
      saveRuleset()
      app.setPluginStatus(statusMessage())
      res.json(removed)
    })

    router.put('/rules', (req, res) => {
      // bulk reorder: body is an array of rule ids in the desired order
      const order = req.body
      if (!Array.isArray(order)) return res.status(400).json({ error: 'Expected an array of ids' })
      ruleset.rules.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
      saveRuleset()
      res.json(ruleset.rules)
    })

    router.get('/activity', (req, res) => {
      res.json(activityLog)
    })
  }

  return plugin
}
