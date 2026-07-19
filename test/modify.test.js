const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('../test-support/harness')

test('modify: forwards the notification with the overridden state', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    label: 'downgrade palma securite',
    match: { path: 'safety.*', vessel: '*' },
    target: 'MODIFY',
    modify: { state: 'warn' },
  })

  h.sendDelta({ mmsi: '224123456', path: 'safety.securite', state: 'alarm', message: 'avisos a los navegantes' })

  assert.equal(h.state.forwarded.length, 1, 'MODIFY should still forward, not drop')
  const forwardedValue = h.state.forwarded[0].updates[0].values[0].value
  assert.equal(forwardedValue.state, 'warn')
  assert.equal(forwardedValue.message, 'avisos a los navegantes', 'other fields should be untouched')
  h.cleanup()
})

test('modify: uses the same (fixed default) target path template as ACCEPT', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'safety.securite', vessel: '*' },
    target: 'MODIFY',
    modify: { state: 'warn' },
  })
  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'alarm' })
  assert.match(
    h.state.forwarded[0].updates[0].values[0].path,
    /^notifications\.received\.safety\.securite\.dsc-[0-9a-f-]{36}$/
  )
  h.cleanup()
})

test('modify: is logged as "modify" with a from→to state summary', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    label: 'downgrade',
    match: { path: 'safety.*', vessel: '*' },
    target: 'MODIFY',
    modify: { state: 'warn' },
  })
  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'alarm' })

  const activity = h.call('GET', '/activity').json
  assert.equal(activity[0].action, 'modify')
  assert.equal(activity[0].state, 'alarm→warn')
  assert.equal(activity[0].rule, 'downgrade')
  h.cleanup()
})

test('modify: an invalid/unknown override state is ignored, forwards unchanged (no override)', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'safety.*', vessel: '*' },
    target: 'MODIFY',
    modify: { state: 'not-a-real-state' },
  })
  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'alarm' })

  assert.equal(h.state.forwarded.length, 1)
  assert.equal(h.state.forwarded[0].updates[0].values[0].value.state, 'alarm', 'should keep original state')
  const activity = h.call('GET', '/activity').json
  assert.equal(activity[0].action, 'accept', 'without a valid override it behaves like a plain ACCEPT')
  h.cleanup()
})

test('modify: sanitizeRule via POST /rules defaults modify.state to null', () => {
  const h = createHarness()
  const created = h.call('POST', '/rules', { target: 'MODIFY' }).json
  assert.equal(created.modify.state, null)
  h.cleanup()
})

test('modify: works via the default policy is not applicable, but a MODIFY rule beats a later ACCEPT rule', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    label: 'modify-first',
    match: { path: 'safety.*', vessel: '*' },
    target: 'MODIFY',
    modify: { state: 'warn' },
  })
  h.call('POST', '/rules', { label: 'accept-fallback', match: { path: '*', vessel: '*' }, target: 'ACCEPT' })

  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'alarm' })
  assert.equal(h.state.forwarded[0].updates[0].values[0].value.state, 'warn')
  h.cleanup()
})
