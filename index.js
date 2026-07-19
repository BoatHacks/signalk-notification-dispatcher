const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const openapi = require('./openApi.json')

const ALL_STATES = ['nominal', 'normal', 'alert', 'warn', 'alarm', 'emergency']
const MAX_ACTIVITY_LOG = 200
const DEFAULT_TARGET_PATH_TEMPLATE = 'notifications.received.{path}.dsc-{uuid}'

module.exports = function (app) {
  let unsubscribes = []
  let activityLog = []
  let rulesetFilePath = null

  // Tracks, per source notification (keyed by "<context>|<subPath>"), the
  // exact target path it was last forwarded/modified to. This is what lets
  // a later clear (value === null) land on the SAME node instead of a
  // freshly re-templated one - which matters since DEFAULT_TARGET_PATH_TEMPLATE
  // contains {uuid}, and re-templating generates a brand new random path
  // every call. Without this, a clear would never reach the originally
  // forwarded copy (leaving it stuck forever) while also creating an
  // unrelated, immediately-stray null-valued entry at a new path. Entries
  // are removed once the source notification is cleared.
  let forwardedTargetPaths = new Map()

  // The ruleset mirrors an iptables-style firewall chain:
  //   - `policy` is the default target (ACCEPT|DROP) applied when no rule matches
  //   - `rules` is an ordered list, evaluated top to bottom, first match wins
  // Each rule has a `match` block (the conditions) and a `target` (the action:
  // ACCEPT = forward, DROP = suppress). Forwarding always uses
  // DEFAULT_TARGET_PATH_TEMPLATE - it isn't configurable per rule.
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
      alwaysAcceptNormal: false,
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
        // When enabled, the rule also matches state transitions to
        // "nominal"/"normal" regardless of the states list above - so a
        // rule narrowly scoped to e.g. alarm/emergency can still catch a
        // source returning to normal, without needing nominal/normal added
        // to its main severity filter.
        alwaysAcceptNormal: !!match.alwaysAcceptNormal,
      },
      target:
        src.target === 'DROP'
          ? 'DROP'
          : src.target === 'MODIFY'
            ? 'MODIFY'
            : src.target === 'ACTION'
              ? 'ACTION'
              : 'ACCEPT',
      // Only meaningful when target === 'MODIFY': overrides the notification's
      // own fields while forwarding it. Currently supports overriding `state`
      // (e.g. downgrading a recurring securité call from alarm to warn
      // instead of dropping it outright) - extend here if more fields need
      // to be modifiable later.
      modify: {
        state: ALL_STATES.includes(src.modify && src.modify.state) ? src.modify.state : null,
      },
      // Only meaningful when target === 'ACTION': writes a value to an
      // arbitrary Signal K path (or calls an arbitrary URL) as a side
      // effect, independent of whether the notification itself gets
      // forwarded. `path` and `value` are plain text and may contain {ref}
      // placeholders - {vessel}/{path}/{uuid} as usual, or a dot-path into
      // the triggering notification's own value (e.g. {state},
      // {status.isAcknowledged}). `mode` picks how the write happens:
      // 'delta' merges it into the data model like ACCEPT/MODIFY do (works
      // for any Signal K path, but isn't a real command); 'put' issues an
      // actual PUT request against the own vessel (only works for paths
      // with a registered put handler, e.g. switches, but is a real
      // actuation); 'rest' calls an arbitrary URL over HTTP (`path` is the
      // URL, `method` the HTTP method, `value` the request body for
      // PUT/POST) - not scoped to Signal K at all, for calling out to other
      // services. `forward` optionally also forwards the notification too,
      // using the fixed DEFAULT_TARGET_PATH_TEMPLATE, same as ACCEPT would.
      action: {
        mode: ['put', 'rest'].includes(src.action && src.action.mode) ? src.action.mode : 'delta',
        path: typeof (src.action && src.action.path) === 'string' ? src.action.path : '',
        value: typeof (src.action && src.action.value) === 'string' ? src.action.value : '',
        method: ['GET', 'PUT', 'POST'].includes(src.action && src.action.method) ? src.action.method : 'GET',
        forward: !!(src.action && src.action.forward),
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
    const alwaysAcceptsThisState = match.alwaysAcceptNormal && (state === 'nominal' || state === 'normal')
    if (!states.includes(state) && !alwaysAcceptsThisState) return false

    if (!isWithinTimebox(match.timebox, timestamp)) return false

    if (isBlockedByVesselState(match.vesselState, ownNavState)) return false

    return true
  }

  // Resolves a single {ref} placeholder against the current delta context.
  // {vessel}/{path}/{uuid} are the existing, path-oriented placeholders.
  // Anything else is treated as a dot-path into the triggering
  // notification's own value object (e.g. {state}, {status.isAcknowledged}),
  // per the ACTION target's "reference the incoming/updated notification"
  // convention. Returns undefined if the reference can't be resolved, so
  // callers can decide how to handle a miss (leave it literal, fall back).
  function resolveTemplateRef(ref, ctx) {
    if (ref === 'vessel') return ctx.vesselLabel
    if (ref === 'path') return ctx.subPath
    if (ref === 'uuid') return crypto.randomUUID()
    if (ctx.notificationValue == null) return undefined
    return ref.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), ctx.notificationValue)
  }

  // Resolves all {ref} placeholders in a string template. A template that's
  // ENTIRELY a single placeholder (e.g. "{status.isAcknowledged}") resolves
  // to the referenced value's own type (boolean/number/object/etc.), not a
  // stringified version - useful for ACTION values. Placeholders embedded in
  // a larger string are stringified in place. An unresolvable reference is
  // left as the literal "{ref}" text rather than silently becoming empty.
  function resolveTemplateString(template, ctx) {
    const str = String(template)
    const fullMatch = /^\{([^{}]+)\}$/.exec(str)
    if (fullMatch) {
      const resolved = resolveTemplateRef(fullMatch[1], ctx)
      return resolved === undefined ? str : resolved
    }
    return str.replace(/\{([^{}]+)\}/g, (whole, ref) => {
      const resolved = resolveTemplateRef(ref, ctx)
      if (resolved === undefined) return whole
      return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved)
    })
  }

  // Resolves an ACTION rule's value template. Values are authored as plain
  // text (a single input field in the webapp), so after placeholder
  // resolution, a string result gets one extra pass through JSON.parse as a
  // convenience type coercion - "true"/"42"/'{"a":1}' become their real
  // types, anything that isn't valid JSON (e.g. "on") stays a plain string.
  // A whole-string {ref} substitution that already resolved to a non-string
  // (e.g. a boolean straight from the notification's own value) is used as-is.
  function resolveActionValue(template, ctx) {
    const resolved = resolveTemplateString(template, ctx)
    if (typeof resolved !== 'string') return resolved
    try {
      return JSON.parse(resolved)
    } catch (err) {
      return resolved
    }
  }

  function buildTargetPath({ subPath, vesselLabel, value }) {
    return resolveTemplateString(DEFAULT_TARGET_PATH_TEMPLATE, { subPath, vesselLabel, notificationValue: value || null })
  }

  // Performs an ACTION rule's configured write. Resolves action.path/value
  // against templateCtx first, then dispatches by mode:
  //   - 'delta': merges the value into the data model (app.handleMessage) -
  //     works for any path, synchronous, effectively can't fail.
  //   - 'put': a real PUT request against the own vessel (app.putSelfPath) -
  //     only paths with a registered put handler, async.
  //   - 'rest': an HTTP request to an arbitrary URL (action.path is the URL,
  //     action.method the HTTP method, action.value the request body for
  //     PUT/POST). Not scoped to Signal K at all - for calling out to other
  //     services (a Node-RED flow, a Home Assistant webhook, etc). Async,
  //     10s timeout, response body is not used for anything.
  // Returns null if action.path is empty (nothing to do), otherwise
  // { resolvedPath, resolvedValue, promise }, where `promise` is null for
  // the synchronous 'delta' mode and a Promise (which the caller should
  // attach failure handling to) for 'put'/'rest'.
  function performAction(action, templateCtx) {
    if (!action || !action.path) return null

    const resolvedPath = resolveTemplateString(action.path, templateCtx)
    const resolvedValue = resolveActionValue(action.value, templateCtx)

    if (action.mode === 'put') {
      return { resolvedPath, resolvedValue, promise: app.putSelfPath(resolvedPath, resolvedValue, () => {}) }
    }

    if (action.mode === 'rest') {
      const method = ['GET', 'PUT', 'POST'].includes(action.method) ? action.method : 'GET'
      const fetchOptions = { method, signal: AbortSignal.timeout(10000) }
      if (method !== 'GET' && action.value) {
        fetchOptions.headers = { 'Content-Type': 'application/json' }
        fetchOptions.body = typeof resolvedValue === 'string' ? resolvedValue : JSON.stringify(resolvedValue)
      }
      const promise = fetch(resolvedPath, fetchOptions).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res
      })
      return { resolvedPath, resolvedValue, promise }
    }

    // 'delta' (default)
    app.handleMessage(plugin.id, { updates: [{ values: [{ path: resolvedPath, value: resolvedValue }] }] })
    return { resolvedPath, resolvedValue, promise: null }
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
        const trackingKey = `${context}|${subPath}`

        if (value === null) {
          // The source notification was cleared. Per the Signal K spec,
          // clearing means the key is removed from the tree entirely, not
          // left sitting there with a null value - so this must land on
          // whatever path we actually forwarded the live notification to,
          // not a freshly re-templated one (which could differ, e.g. with
          // {uuid} in the template).
          const trackedPath = forwardedTargetPaths.get(trackingKey)
          if (trackedPath) {
            app.handleMessage(plugin.id, {
              updates: [{ values: [{ path: trackedPath, value: null }] }],
            })
            forwardedTargetPaths.delete(trackingKey)
            logActivity({
              action: 'clear',
              rule: 'source cleared',
              sourcePath: valuePath,
              targetPath: trackedPath,
              vessel: vesselLabel,
              state: 'cleared',
            })
          }
          // Nothing was ever forwarded for this notification (e.g. it was
          // always DROPped) - nothing to clear.
          return
        }

        const state = value && value.state ? value.state : 'normal'

        const matchInfo = { subPath, context, vesselLabel, state, timestamp, ownNavState }
        const matchedRule = ruleset.rules.find((rule) => matchesRule(rule, matchInfo))

        // Fall back to the chain's default policy (ACCEPT/DROP) when no rule
        // matches - mirroring an iptables chain's default policy.
        const effectiveRule = matchedRule || {
          id: 'default-policy',
          label: `default policy (${ruleset.policy})`,
          target: ruleset.policy,
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

        if (effectiveRule.target === 'ACTION') {
          const templateCtx = { subPath, vesselLabel, notificationValue: value }
          const action = effectiveRule.action || {}
          const result = performAction(action, templateCtx)

          if (result && result.promise) {
            result.promise.catch((err) => {
              app.error(`ACTION ${action.mode} failed for ${result.resolvedPath}: ${err.message}`)
              logActivity({
                action: 'action-error',
                rule: effectiveRule.label || effectiveRule.id,
                sourcePath: valuePath,
                vessel: vesselLabel,
                state,
                actionMode: action.mode,
                actionPath: result.resolvedPath,
                actionValue: result.resolvedValue,
                error: err.message,
              })
            })
          }

          let targetPath = null
          if (action.forward) {
            targetPath = forwardedTargetPaths.get(trackingKey)
            if (!targetPath) {
              targetPath = buildTargetPath({ subPath, vesselLabel, value })
              forwardedTargetPaths.set(trackingKey, targetPath)
            }
            app.handleMessage(plugin.id, {
              updates: [{ values: [{ path: targetPath, value }] }],
            })
          }

          logActivity({
            action: 'action',
            rule: effectiveRule.label || effectiveRule.id,
            sourcePath: valuePath,
            targetPath: targetPath || undefined,
            vessel: vesselLabel,
            state,
            actionMode: action.mode,
            actionPath: result ? result.resolvedPath : undefined,
            actionValue: result ? result.resolvedValue : undefined,
          })
          return
        }

        const isNormalTransition = state === 'nominal' || state === 'normal'
        const matchedViaAlwaysAcceptNormal =
          matchedRule && matchedRule.match && matchedRule.match.alwaysAcceptNormal && isNormalTransition

        const isModify =
          !matchedViaAlwaysAcceptNormal &&
          effectiveRule.target === 'MODIFY' &&
          effectiveRule.modify &&
          effectiveRule.modify.state
        const outValue = isModify ? { ...value, state: effectiveRule.modify.state } : value

        // Reuse the path this same (still-active) source notification was
        // last forwarded to, if any, rather than re-templating one on every
        // update - otherwise a template using {uuid} would spawn a brand
        // new node on every re-raise instead of updating the existing one,
        // and would make clearing it (above) impossible to target correctly.
        let targetPath = forwardedTargetPaths.get(trackingKey)
        if (!targetPath) {
          targetPath = buildTargetPath({ subPath, vesselLabel, value })
          forwardedTargetPaths.set(trackingKey, targetPath)
        }

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

  // If a plugin provides an API, SignalK's convention is to implement
  // getOpenApi() returning the parsed openApi.json - this surfaces the
  // definition in the server's Admin UI under Documentation -> OpenAPI.
  plugin.getOpenApi = () => openapi

  plugin.registerWithRouter = function (router) {
    // Every response here reflects live, frequently-mutated state (the
    // ruleset and the activity log) - never let a client or intermediary
    // cache a GET and serve it back stale after a POST/PUT/DELETE.
    if (typeof router.use === 'function') {
      router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store')
        next()
      })
    }

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

    // Every path currently flowing through the server, for the ACTION
    // target's path picker in the webapp. Not scoped to notifications -
    // ACTION can write to any path.
    router.get('/paths', (req, res) => {
      try {
        const paths =
          app.streambundle && typeof app.streambundle.getAvailablePaths === 'function'
            ? app.streambundle.getAvailablePaths()
            : []
        res.json(paths)
      } catch (err) {
        res.status(500).json({ error: err.message })
      }
    })
  }

  return plugin
}
