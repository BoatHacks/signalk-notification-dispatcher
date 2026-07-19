const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('../test-support/harness')

test('clearing: a cleared (null) source notification clears the forwarded copy at the same path', () => {
  const h = createHarness()
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })
  const targetPath = h.state.forwarded[0].updates[0].values[0].path

  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', clear: true })
  assert.equal(h.state.forwarded.length, 2)
  const clearUpdate = h.state.forwarded[1].updates[0].values[0]
  assert.equal(clearUpdate.path, targetPath, 'clear should target the exact same path the alarm was forwarded to')
  assert.equal(clearUpdate.value, null)
  h.cleanup()
})

test('clearing: {uuid} in the target path template - the clear reuses the SAME generated uuid, not a fresh one', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'urgency.*', vessel: '*' },
    target: 'ACCEPT',
  })

  h.sendDelta({ mmsi: '211234567', path: 'urgency.test', state: 'alarm' })
  const raisedPath = h.state.forwarded[0].updates[0].values[0].path

  h.sendDelta({ mmsi: '211234567', path: 'urgency.test', clear: true })
  const clearedPath = h.state.forwarded[1].updates[0].values[0].path

  assert.equal(clearedPath, raisedPath, 'the clear must land on the exact uuid-suffixed path the alarm used, not a newly-generated one')
  assert.equal(h.state.forwarded[1].updates[0].values[0].value, null)
  h.cleanup()
})

test('clearing: repeated (non-cleared) updates to the same notification land on the same path, even with {uuid}', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'urgency.*', vessel: '*' },
    target: 'ACCEPT',
  })

  h.sendDelta({ mmsi: '1', path: 'urgency.test', state: 'alarm', message: 'first' })
  h.sendDelta({ mmsi: '1', path: 'urgency.test', state: 'alarm', message: 'updated' })
  h.sendDelta({ mmsi: '1', path: 'urgency.test', state: 'alarm', message: 'updated again' })

  const paths = h.state.forwarded.map((d) => d.updates[0].values[0].path)
  assert.equal(new Set(paths).size, 1, 'all three updates should land on the same generated path, not three different ones')
  h.cleanup()
})

test('clearing: after a clear, a new occurrence of the same notification gets a fresh path (new {uuid})', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'urgency.*', vessel: '*' },
    target: 'ACCEPT',
  })

  h.sendDelta({ mmsi: '1', path: 'urgency.test', state: 'alarm' })
  const firstPath = h.state.forwarded[0].updates[0].values[0].path

  h.sendDelta({ mmsi: '1', path: 'urgency.test', clear: true })

  h.sendDelta({ mmsi: '1', path: 'urgency.test', state: 'alarm' })
  const secondPath = h.state.forwarded[2].updates[0].values[0].path

  assert.notEqual(secondPath, firstPath, 'a new occurrence after a clear should get its own fresh path')
  h.cleanup()
})

test('clearing: clearing something that was never forwarded (e.g. always DROPped) sends nothing', () => {
  const h = createHarness()
  h.call('POST', '/rules', { match: { path: 'safety.*', vessel: '*' }, target: 'DROP' })

  h.sendDelta({ mmsi: '1', path: 'safety.test', state: 'warn' })
  assert.equal(h.state.forwarded.length, 0)

  h.sendDelta({ mmsi: '1', path: 'safety.test', clear: true })
  assert.equal(h.state.forwarded.length, 0, 'nothing was ever forwarded, so there is nothing to clear')
  h.cleanup()
})

test('clearing: clears are logged distinctly and remove the tracked path', () => {
  const h = createHarness()
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', clear: true })

  const activity = h.call('GET', '/activity').json
  assert.equal(activity[0].action, 'clear')
  assert.equal(activity[0].targetPath, h.state.forwarded[0].updates[0].values[0].path)
  h.cleanup()
})

test('clearing: MODIFY-target notifications are also clearable at their forwarded path', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'safety.*', vessel: '*' },
    target: 'MODIFY',
    modify: { state: 'warn' },
  })

  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'alarm' })
  const forwardedPath = h.state.forwarded[0].updates[0].values[0].path

  h.sendDelta({ mmsi: '1', path: 'safety.securite', clear: true })
  assert.equal(h.state.forwarded[1].updates[0].values[0].path, forwardedPath)
  assert.equal(h.state.forwarded[1].updates[0].values[0].value, null)
  h.cleanup()
})
