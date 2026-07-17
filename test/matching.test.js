const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('../test-support/harness')

test('matching: own vessel is always ignored', () => {
  const h = createHarness()
  h.sendDelta({ context: h.app.selfContext, path: 'test.path', state: 'alarm' })
  assert.equal(h.state.forwarded.length, 0)
  h.cleanup()
})

test('matching: DROP rule with exact path suppresses, ACCEPT default forwards everything else', () => {
  const h = createHarness()
  h.call('POST', '/rules', { match: { path: 'navigation.anchor', vessel: '*' }, target: 'DROP' })

  h.sendDelta({ mmsi: '111111111', path: 'navigation.anchor', state: 'alarm' })
  assert.equal(h.state.forwarded.length, 0, 'exact-path DROP rule should suppress')

  h.sendDelta({ mmsi: '111111111', path: 'navigation.anchorOther', state: 'alarm' })
  assert.equal(h.state.forwarded.length, 1, 'non-matching path should fall through to ACCEPT policy')
  h.cleanup()
})

test('matching: wildcard path pattern', () => {
  const h = createHarness()
  h.call('POST', '/rules', { match: { path: 'navigation.anchor*', vessel: '*' }, target: 'DROP' })

  h.sendDelta({ mmsi: '111111111', path: 'navigation.anchorDrag', state: 'alarm' })
  assert.equal(h.state.forwarded.length, 0)

  h.sendDelta({ mmsi: '111111111', path: 'safety.securite', state: 'warn' })
  assert.equal(h.state.forwarded.length, 1)
  h.cleanup()
})

test('matching: vessel filter by MMSI only affects that vessel', () => {
  const h = createHarness()
  h.call('POST', '/rules', { match: { path: '*', vessel: '211234567' }, target: 'DROP' })

  h.sendDelta({ mmsi: '211234567', path: 'urgency.test', state: 'alarm' })
  assert.equal(h.state.forwarded.length, 0, 'matching MMSI should be dropped')

  h.sendDelta({ mmsi: '999999999', path: 'urgency.test', state: 'alarm' })
  assert.equal(h.state.forwarded.length, 1, 'different MMSI should still be forwarded')
  h.cleanup()
})

test('matching: states filter restricts which notification states trigger the rule', () => {
  const h = createHarness()
  h.call('POST', '/rules', { match: { path: 'safety.*', vessel: '*', states: ['warn'] }, target: 'DROP' })

  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'warn' })
  assert.equal(h.state.forwarded.length, 0, 'warn state should match and drop')

  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'alert' })
  assert.equal(h.state.forwarded.length, 1, 'alert state should not match, falls through to ACCEPT')
  h.cleanup()
})

test('matching: rules are evaluated top to bottom, first match wins', () => {
  const h = createHarness()
  // Narrow DROP rule first...
  const r1 = h.call('POST', '/rules', { label: 'narrow-drop', match: { path: 'urgency.*', vessel: '211234567' }, target: 'DROP' })
  // ...then a broader ACCEPT rule for the same vessel.
  h.call('POST', '/rules', { label: 'broad-accept', match: { path: '*', vessel: '211234567' }, target: 'ACCEPT' })

  h.sendDelta({ mmsi: '211234567', path: 'urgency.test', state: 'alarm' })
  assert.equal(h.state.forwarded.length, 0, 'the first (narrower) rule should win')

  h.sendDelta({ mmsi: '211234567', path: 'safety.test', state: 'alert' })
  assert.equal(h.state.forwarded.length, 1, 'a path not matching the first rule should hit the second')
  h.cleanup()
})

test('matching: a disabled rule is skipped entirely', () => {
  const h = createHarness()
  const created = h.call('POST', '/rules', { match: { path: '*', vessel: '*' }, target: 'DROP' }).json
  h.call('PUT', `/rules/${created.id}`, { enabled: false })

  h.sendDelta({ mmsi: '1', path: 'safety.test', state: 'alert' })
  assert.equal(h.state.forwarded.length, 1, 'disabled rule should not apply, falls through to ACCEPT')
  h.cleanup()
})

test('matching: ACCEPT rule forwards with the target path template applied', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'navigation.anchor', vessel: '*' },
    target: 'ACCEPT',
    targetPathTemplate: 'notifications.received.custom.{vessel}.{path}',
  })
  h.sendDelta({ mmsi: '211234567', path: 'navigation.anchor', state: 'alarm' })
  assert.equal(h.state.forwarded.length, 1)
  assert.equal(
    h.state.forwarded[0].updates[0].values[0].path,
    'notifications.received.custom.211234567.navigation.anchor'
  )
  h.cleanup()
})
