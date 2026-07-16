const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('../test-support/harness')

test('vessel-state gating: rule with blockWhenMoored is skipped while moored', () => {
  const h = createHarness()
  h.setNavigationState('moored')
  h.call('POST', '/rules', {
    match: { path: '*', vessel: '*', vesselState: { blockWhenMoored: true, blockWhenAnchored: false } },
    target: 'DROP',
  })

  h.sendDelta({ mmsi: '1', path: 'safety.test', state: 'alert' })
  assert.equal(h.state.forwarded.length, 1, 'rule should be skipped while moored, falls through to ACCEPT')
  h.cleanup()
})

test('vessel-state gating: rule with blockWhenMoored still applies when not moored', () => {
  const h = createHarness()
  h.setNavigationState('motoring')
  h.call('POST', '/rules', {
    match: { path: '*', vessel: '*', vesselState: { blockWhenMoored: true, blockWhenAnchored: false } },
    target: 'DROP',
  })

  h.sendDelta({ mmsi: '1', path: 'safety.test', state: 'alert' })
  assert.equal(h.state.forwarded.length, 0, 'rule should still apply while motoring')
  h.cleanup()
})

test('vessel-state gating: blockWhenAnchored is independent of blockWhenMoored', () => {
  const h = createHarness()
  h.setNavigationState('anchored')
  h.call('POST', '/rules', {
    match: { path: '*', vessel: '*', vesselState: { blockWhenMoored: true, blockWhenAnchored: false } },
    target: 'DROP',
  })

  h.sendDelta({ mmsi: '1', path: 'safety.test', state: 'alert' })
  assert.equal(h.state.forwarded.length, 0, 'blockWhenAnchored is false, so anchored should not skip this rule')
  h.cleanup()
})

test('vessel-state gating: both toggles enabled at once, either state skips the rule', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: '*', vessel: '*', vesselState: { blockWhenMoored: true, blockWhenAnchored: true } },
    target: 'DROP',
  })

  h.setNavigationState('moored')
  h.sendDelta({ mmsi: '1', path: 'safety.a', state: 'alert' })
  assert.equal(h.state.forwarded.length, 1)

  h.setNavigationState('anchored')
  h.sendDelta({ mmsi: '1', path: 'safety.b', state: 'alert' })
  assert.equal(h.state.forwarded.length, 2)

  h.setNavigationState('motoring')
  h.sendDelta({ mmsi: '1', path: 'safety.c', state: 'alert' })
  assert.equal(h.state.forwarded.length, 2, 'motoring should not skip the rule, so it drops as normal')
  h.cleanup()
})

test('vessel-state gating: no gate configured means navigation.state is irrelevant', () => {
  const h = createHarness()
  h.setNavigationState('moored')
  h.call('POST', '/rules', { match: { path: '*', vessel: '*' }, target: 'DROP' })

  h.sendDelta({ mmsi: '1', path: 'safety.test', state: 'alert' })
  assert.equal(h.state.forwarded.length, 0)
  h.cleanup()
})
