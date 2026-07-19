const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('../test-support/harness')

test('action: delta mode writes the resolved value to the resolved path', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'navigation.anchor', vessel: '*' },
    target: 'ACTION',
    action: { mode: 'delta', path: 'electrical.switches.anchorAlarm.state', value: 'true' },
  })
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })

  assert.equal(h.state.forwarded.length, 1)
  const written = h.state.forwarded[0].updates[0].values[0]
  assert.equal(written.path, 'electrical.switches.anchorAlarm.state')
  assert.equal(written.value, true)
  assert.equal(typeof written.value, 'boolean', 'value should be coerced to a real boolean, not the string "true"')
  h.cleanup()
})

test('action: put mode calls app.putSelfPath instead of handleMessage', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'navigation.anchor', vessel: '*' },
    target: 'ACTION',
    action: { mode: 'put', path: 'electrical.switches.anchorAlarm.state', value: 'true' },
  })
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })

  assert.equal(h.state.forwarded.length, 0, 'put mode should not go through handleMessage')
  assert.equal(h.state.putCalls.length, 1)
  assert.equal(h.state.putCalls[0].path, 'electrical.switches.anchorAlarm.state')
  assert.equal(h.state.putCalls[0].value, true)
  h.cleanup()
})

test('action: path and value can reference the triggering notification, including nested dot-paths', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'urgency.*', vessel: '*' },
    target: 'ACTION',
    action: { mode: 'delta', path: 'notifications.mirrored.{path}', value: '{status.isAcknowledged}' },
  })
  h.sendDelta({
    mmsi: '211234567',
    path: 'urgency.test',
    state: 'alarm',
    extra: { status: { isAcknowledged: true, level: 3 } },
  })

  const written = h.state.forwarded[0].updates[0].values[0]
  assert.equal(written.path, 'notifications.mirrored.urgency.test')
  assert.equal(written.value, true)
  h.cleanup()
})

test('action: {vessel} and {uuid} placeholders work in the action path too', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'urgency.*', vessel: '*' },
    target: 'ACTION',
    action: { mode: 'delta', path: 'notifications.mirrored.{vessel}.{path}-{uuid}', value: '"marked"' },
  })
  h.sendDelta({ mmsi: '211234567', path: 'urgency.test', state: 'alarm' })

  const written = h.state.forwarded[0].updates[0].values[0]
  assert.match(written.path, /^notifications\.mirrored\.211234567\.urgency\.test-[0-9a-f-]{36}$/)
  assert.equal(written.value, 'marked')
  h.cleanup()
})

test('action: an unresolvable reference is left as literal text', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'navigation.anchor', vessel: '*' },
    target: 'ACTION',
    action: { mode: 'delta', path: 'electrical.switches.x.state', value: '{nope}' },
  })
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })
  assert.equal(h.state.forwarded[0].updates[0].values[0].value, '{nope}')
  h.cleanup()
})

test('action: forward=false (default) does not also forward the notification', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'navigation.anchor', vessel: '*' },
    target: 'ACTION',
    action: { mode: 'delta', path: 'electrical.switches.x.state', value: 'true' },
  })
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })
  assert.equal(h.state.forwarded.length, 1, 'only the action write, not a second forwarded copy')
  h.cleanup()
})

test('action: forward=true also forwards via the normal targetPathTemplate mechanism', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'navigation.anchor', vessel: '*' },
    target: 'ACTION',
    action: { mode: 'delta', path: 'electrical.switches.x.state', value: 'true', forward: true },
    targetPathTemplate: 'notifications.received.custom.{path}',
  })
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })

  assert.equal(h.state.forwarded.length, 2)
  const paths = h.state.forwarded.map((d) => d.updates[0].values[0].path)
  assert.ok(paths.includes('electrical.switches.x.state'))
  assert.ok(paths.includes('notifications.received.custom.navigation.anchor'))
  h.cleanup()
})

test('action: forward=true reuses the same tracked path across updates, and clears correctly', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'urgency.*', vessel: '*' },
    target: 'ACTION',
    action: { mode: 'delta', path: 'electrical.switches.x.state', value: 'true', forward: true },
    targetPathTemplate: 'notifications.received.{path}-{uuid}',
  })
  h.sendDelta({ mmsi: '1', path: 'urgency.test', state: 'alarm' })
  h.sendDelta({ mmsi: '1', path: 'urgency.test', state: 'alarm' })

  const forwardPaths = h.state.forwarded
    .map((d) => d.updates[0].values[0].path)
    .filter((p) => p.startsWith('notifications.received'))
  assert.equal(new Set(forwardPaths).size, 1, 'repeated updates should reuse the same forwarded path')

  h.sendDelta({ mmsi: '1', path: 'urgency.test', clear: true })
  const lastWrite = h.state.forwarded[h.state.forwarded.length - 1].updates[0].values[0]
  assert.equal(lastWrite.path, forwardPaths[0])
  assert.equal(lastWrite.value, null)
  h.cleanup()
})

test('action: no action.path configured skips the write but still logs, forward still works if enabled', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'navigation.anchor', vessel: '*' },
    target: 'ACTION',
    action: { mode: 'delta', path: '', value: 'true', forward: true },
    targetPathTemplate: 'notifications.received.custom.{path}',
  })
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })
  assert.equal(h.state.forwarded.length, 1, 'only the forward, no action write since path is empty')
  assert.equal(h.state.forwarded[0].updates[0].values[0].path, 'notifications.received.custom.navigation.anchor')
  h.cleanup()
})

test('action: a failed put logs an action-error entry', async () => {
  const h = createHarness({
    putSelfPathImpl: () => {
      throw new Error('no handler registered')
    },
  })
  h.call('POST', '/rules', {
    match: { path: 'navigation.anchor', vessel: '*' },
    target: 'ACTION',
    action: { mode: 'put', path: 'electrical.switches.x.state', value: 'true' },
  })
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })

  // The put failure is async (a rejected promise) - give it a tick.
  await new Promise((resolve) => setTimeout(resolve, 20))

  const activity = h.call('GET', '/activity').json
  assert.equal(activity[0].action, 'action-error')
  assert.match(activity[0].error, /no handler registered/)
  h.cleanup()
})

test('action: activity log entry includes actionMode/actionPath/actionValue', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    label: 'flash light',
    match: { path: 'navigation.anchor', vessel: '*' },
    target: 'ACTION',
    action: { mode: 'delta', path: 'electrical.switches.x.state', value: 'true' },
  })
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })

  const activity = h.call('GET', '/activity').json
  assert.equal(activity[0].action, 'action')
  assert.equal(activity[0].rule, 'flash light')
  assert.equal(activity[0].actionMode, 'delta')
  assert.equal(activity[0].actionPath, 'electrical.switches.x.state')
  assert.equal(activity[0].actionValue, true)
  h.cleanup()
})

test('action: sanitizeRule defaults on a freshly created ACTION rule', () => {
  const h = createHarness()
  const created = h.call('POST', '/rules', { target: 'ACTION' }).json
  assert.deepEqual(created.action, { mode: 'delta', path: '', value: '', forward: false })
  h.cleanup()
})

test('GET /paths returns the server-known paths for the ACTION picker', () => {
  const h = createHarness({ knownPaths: ['navigation.position', 'electrical.switches.anchorLight.state'] })
  const res = h.call('GET', '/paths')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json, ['navigation.position', 'electrical.switches.anchorLight.state'])
  h.cleanup()
})

test('GET /paths returns an empty array if streambundle is unavailable', () => {
  const h = createHarness()
  h.app.streambundle = undefined
  const res = h.call('GET', '/paths')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json, [])
  h.cleanup()
})
