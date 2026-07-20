const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Ajv2020 = require('ajv/dist/2020')
const { createHarness } = require('../test-support/harness')

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'rules-schema.json'), 'utf8'))
const ajv = new Ajv2020({ strict: true })
const validate = ajv.compile(schema)

test('schema: docs/rules-schema.json is itself a valid, compilable JSON Schema', () => {
  assert.ok(validate, 'ajv should compile the schema without throwing')
})

test('schema: a freshly created default rule validates', () => {
  const h = createHarness()
  h.call('POST', '/rules', { label: 'plain' })
  const ruleset = h.call('GET', '/ruleset').json
  const ok = validate(ruleset)
  assert.ok(ok, JSON.stringify(validate.errors))
  h.cleanup()
})

test('schema: a rule using every feature (timebox, crontab, vessel-state gate, MODIFY) validates', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    label: 'kitchen sink',
    match: {
      path: 'safety.*',
      vessel: '211234567',
      states: ['alert', 'warn'],
      timebox: { enabled: true, times: ['02:15', '15 2,6,10,14,18,22 * * *'], toleranceMinutes: 5 },
      vesselState: { blockWhenMoored: true, blockWhenAnchored: true },
    },
    target: 'MODIFY',
    modify: { state: 'alert' },
    targetPathTemplate: 'notifications.received.custom.{vessel}.{path}',
  })
  h.call('PUT', '/policy', { policy: 'DROP' })

  const ruleset = h.call('GET', '/ruleset').json
  const ok = validate(ruleset)
  assert.ok(ok, JSON.stringify(validate.errors))
  h.cleanup()
})

test('schema: an empty ruleset (no rules yet) validates', () => {
  const h = createHarness()
  const ruleset = h.call('GET', '/ruleset').json
  assert.ok(validate(ruleset), JSON.stringify(validate.errors))
  h.cleanup()
})

test('schema: rejects an invalid policy value', () => {
  assert.equal(validate({ policy: 'MAYBE', rules: [] }), false)
})

test('schema: rejects a rule with an unknown target', () => {
  const h = createHarness()
  const ruleset = h.call('GET', '/ruleset').json
  ruleset.rules.push({
    id: 'x',
    label: '',
    enabled: true,
    match: {
      path: '*',
      vessel: '*',
      states: [],
      timebox: { enabled: false, times: [], toleranceMinutes: 5 },
      vesselState: { blockWhenMoored: false, blockWhenAnchored: false },
    },
    target: 'REJECT',
    targetPathTemplate: 'x',
    modify: { state: null },
  })
  assert.equal(validate(ruleset), false)
  h.cleanup()
})

test('schema: rejects an unknown notification state in match.states', () => {
  const h = createHarness()
  const ruleset = h.call('GET', '/ruleset').json
  ruleset.rules.push({
    id: 'x',
    label: '',
    enabled: true,
    match: {
      path: '*',
      vessel: '*',
      states: ['critical'],
      timebox: { enabled: false, times: [], toleranceMinutes: 5 },
      vesselState: { blockWhenMoored: false, blockWhenAnchored: false },
    },
    target: 'ACCEPT',
    targetPathTemplate: 'x',
    modify: { state: null },
  })
  assert.equal(validate(ruleset), false)
  h.cleanup()
})
