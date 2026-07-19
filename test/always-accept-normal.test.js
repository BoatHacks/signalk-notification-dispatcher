const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('../test-support/harness')

test('alwaysAcceptNormal: a rule scoped to alarm/emergency also matches a return to normal when enabled', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'safety.*', vessel: '*', states: ['alarm', 'emergency'], alwaysAcceptNormal: true },
    target: 'DROP',
  })

  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'normal' })
  assert.equal(h.state.forwarded.length, 0, 'normal should match the rule (dropped), not fall through to ACCEPT policy')

  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'nominal' })
  assert.equal(h.state.forwarded.length, 0, 'nominal should also match')
  h.cleanup()
})

test('alwaysAcceptNormal: disabled by default, nominal/normal fall through to the default policy as usual', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'safety.*', vessel: '*', states: ['alarm', 'emergency'] },
    target: 'DROP',
  })

  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'normal' })
  assert.equal(h.state.forwarded.length, 1, 'without the flag, normal should not match this rule, falls through to ACCEPT policy')
  h.cleanup()
})

test('alwaysAcceptNormal: does not bypass the other match conditions (path/vessel still apply)', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'safety.securite', vessel: '211234567', states: ['alarm'], alwaysAcceptNormal: true },
    target: 'DROP',
  })

  // Wrong path - should not match even though alwaysAcceptNormal is on.
  h.sendDelta({ mmsi: '211234567', path: 'safety.other', state: 'normal' })
  assert.equal(h.state.forwarded.length, 1, 'wrong path should still fall through to ACCEPT policy')

  // Wrong vessel - should also not match.
  h.sendDelta({ mmsi: '999999999', path: 'safety.securite', state: 'normal' })
  assert.equal(h.state.forwarded.length, 2, 'wrong vessel should still fall through to ACCEPT policy')

  // Correct path+vessel - should match via alwaysAcceptNormal.
  h.sendDelta({ mmsi: '211234567', path: 'safety.securite', state: 'normal' })
  assert.equal(h.state.forwarded.length, 2, 'matching path+vessel with normal state should be dropped by the rule')
  h.cleanup()
})

test('alwaysAcceptNormal: still respects vessel-state gating', () => {
  const h = createHarness()
  h.setNavigationState('moored')
  h.call('POST', '/rules', {
    match: {
      path: 'safety.*',
      vessel: '*',
      states: ['alarm'],
      alwaysAcceptNormal: true,
      vesselState: { blockWhenMoored: true, blockWhenAnchored: false },
    },
    target: 'DROP',
  })

  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'normal' })
  assert.equal(h.state.forwarded.length, 1, 'rule should be skipped while moored, even for a normal-state transition')
  h.cleanup()
})

test('alwaysAcceptNormal: a normal/nominal state already in the states list works as before', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'safety.*', vessel: '*', states: ['normal'] },
    target: 'DROP',
  })
  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'normal' })
  assert.equal(h.state.forwarded.length, 0)
  h.cleanup()
})

test('alwaysAcceptNormal: defaults to false on a freshly created rule', () => {
  const h = createHarness()
  const created = h.call('POST', '/rules', { label: 'plain' }).json
  assert.equal(created.match.alwaysAcceptNormal, false)
  h.cleanup()
})

test('alwaysAcceptNormal: a MODIFY rule is bypassed (forwarded via ACCEPT unmodified) on a return to normal', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    label: 'downgrade palma securite',
    match: { path: 'safety.*', vessel: '*', states: ['alarm'], alwaysAcceptNormal: true },
    target: 'MODIFY',
    modify: { state: 'warn' },
  })

  // Normal MODIFY behavior for a matching (alarm) state.
  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'alarm' })
  assert.equal(h.state.forwarded[0].updates[0].values[0].value.state, 'warn', 'alarm should still be downgraded as configured')

  // A return to normal should bypass MODIFY entirely and forward unmodified.
  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'normal' })
  const forwardedValue = h.state.forwarded[1].updates[0].values[0].value
  assert.equal(forwardedValue.state, 'normal', 'the normal state should be forwarded as-is, not overridden by modify.state')

  const activity = h.call('GET', '/activity').json
  assert.equal(activity[0].action, 'accept', 'the return-to-normal should be logged as accept, not modify')
  h.cleanup()
})

test('alwaysAcceptNormal: also bypasses MODIFY for nominal, not just normal', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'safety.*', vessel: '*', states: ['alarm'], alwaysAcceptNormal: true },
    target: 'MODIFY',
    modify: { state: 'warn' },
  })
  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'nominal' })
  assert.equal(h.state.forwarded[0].updates[0].values[0].value.state, 'nominal')
  h.cleanup()
})

test('alwaysAcceptNormal: without the flag, MODIFY still applies even if normal were explicitly in the states list', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'safety.*', vessel: '*', states: ['alarm', 'normal'] },
    target: 'MODIFY',
    modify: { state: 'warn' },
  })
  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'normal' })
  assert.equal(
    h.state.forwarded[0].updates[0].values[0].value.state,
    'warn',
    'without alwaysAcceptNormal, a normal state matched via the states list still goes through MODIFY as configured'
  )
  h.cleanup()
})

test('alwaysAcceptNormal: does not affect a DROP-targeted rule (only MODIFY is bypassed)', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'safety.*', vessel: '*', states: ['alarm'], alwaysAcceptNormal: true },
    target: 'DROP',
  })
  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'normal' })
  assert.equal(h.state.forwarded.length, 0, 'a DROP rule matched via alwaysAcceptNormal should still drop, not forward')
  const activity = h.call('GET', '/activity').json
  assert.equal(activity[0].action, 'drop')
  h.cleanup()
})
