const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('../test-support/harness')

test('ruleset-json: GET /ruleset returns the full { policy, rules } shape', () => {
  const h = createHarness()
  h.call('POST', '/rules', { label: 'r1' })
  const res = h.call('GET', '/ruleset').json
  assert.equal(res.policy, 'ACCEPT')
  assert.equal(res.rules.length, 1)
  assert.equal(res.rules[0].label, 'r1')
  h.cleanup()
})

test('ruleset-json: PUT /ruleset replaces the whole ruleset and is reflected in matching', () => {
  const h = createHarness()
  h.call('POST', '/rules', { label: 'old' })

  const imported = {
    policy: 'DROP',
    rules: [{ label: 'imported', match: { path: 'navigation.anchor', vessel: '*' }, target: 'ACCEPT' }],
  }
  const res = h.call('PUT', '/ruleset', imported)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.rules.length, 1)
  assert.equal(res.json.rules[0].label, 'imported')
  assert.ok(res.json.rules[0].id, 'imported rule should get a generated id')

  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })
  assert.equal(h.state.forwarded.length, 1, 'imported ACCEPT rule should forward')

  h.sendDelta({ mmsi: '1', path: 'other.thing', state: 'alarm' })
  assert.equal(h.state.forwarded.length, 1, 'unmatched notification should hit the imported DROP policy')
  h.cleanup()
})

test('ruleset-json: PUT /ruleset sanitizes a partial/hand-edited rule with defaults', () => {
  const h = createHarness()
  const res = h.call('PUT', '/ruleset', { policy: 'ACCEPT', rules: [{ label: 'sparse' }] })
  const rule = res.json.rules[0]
  assert.equal(rule.match.path, '*')
  assert.equal(rule.match.vessel, '*')
  assert.deepEqual(rule.match.states, ['alert', 'warn', 'alarm', 'emergency'])
  assert.equal(rule.target, 'ACCEPT')
  assert.equal(rule.match.timebox.enabled, false)
  assert.equal(rule.match.vesselState.blockWhenMoored, false)
  h.cleanup()
})

test('ruleset-json: PUT /ruleset rejects a non-object body', () => {
  const h = createHarness()
  const res = h.call('PUT', '/ruleset', [1, 2, 3])
  assert.equal(res.statusCode, 400)
  h.cleanup()
})

test('ruleset-json: PUT /ruleset rejects a body whose rules field is not an array', () => {
  const h = createHarness()
  const res = h.call('PUT', '/ruleset', { policy: 'ACCEPT', rules: 'nope' })
  assert.equal(res.statusCode, 400)
  h.cleanup()
})

test('ruleset-json: PUT /ruleset defaults an invalid/missing policy to ACCEPT', () => {
  const h = createHarness()
  const res = h.call('PUT', '/ruleset', { rules: [] })
  assert.equal(res.json.policy, 'ACCEPT')
  h.cleanup()
})

test('ruleset-json: round-trip export then import preserves behavior', () => {
  const h = createHarness()
  h.call('POST', '/rules', { label: 'r', match: { path: 'urgency.*', vessel: '211234567' }, target: 'DROP' })
  const exported = h.call('GET', '/ruleset').json

  const h2 = createHarness()
  h2.call('PUT', '/ruleset', exported)

  h2.sendDelta({ mmsi: '211234567', path: 'urgency.test', state: 'alarm' })
  assert.equal(h2.state.forwarded.length, 0)

  h.cleanup()
  h2.cleanup()
})
