const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('../test-support/harness')

test('policy: defaults to ACCEPT (permit-all) with no rules', () => {
  const h = createHarness()
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })
  assert.equal(h.state.forwarded.length, 1)
  h.cleanup()
})

test('policy: switching to DROP suppresses everything not matched by a rule', () => {
  const h = createHarness()
  h.call('PUT', '/policy', { policy: 'DROP' })

  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })
  assert.equal(h.state.forwarded.length, 0)
  h.cleanup()
})

test('policy: an ACCEPT rule still forwards even when the default policy is DROP', () => {
  const h = createHarness()
  h.call('PUT', '/policy', { policy: 'DROP' })
  h.call('POST', '/rules', { match: { path: 'navigation.anchor', vessel: '*' }, target: 'ACCEPT' })

  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })
  assert.equal(h.state.forwarded.length, 1)

  h.sendDelta({ mmsi: '1', path: 'safety.other', state: 'warn' })
  assert.equal(h.state.forwarded.length, 1, 'non-matching path should still hit the DROP policy')
  h.cleanup()
})

test('policy: GET /policy reflects current value', () => {
  const h = createHarness()
  assert.deepEqual(h.call('GET', '/policy').json, { policy: 'ACCEPT' })
  h.call('PUT', '/policy', { policy: 'DROP' })
  assert.deepEqual(h.call('GET', '/policy').json, { policy: 'DROP' })
  h.cleanup()
})

test('policy: PUT /policy rejects invalid values', () => {
  const h = createHarness()
  const res = h.call('PUT', '/policy', { policy: 'MAYBE' })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(h.call('GET', '/policy').json, { policy: 'ACCEPT' }, 'policy should be unchanged')
  h.cleanup()
})
