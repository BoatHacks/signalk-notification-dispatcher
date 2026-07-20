const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('../test-support/harness')

test('rest-api: POST /rules creates a rule with sane defaults', () => {
  const h = createHarness()
  const res = h.call('POST', '/rules', { label: 'my rule' })
  assert.equal(res.statusCode, 200)
  assert.ok(res.json.id)
  assert.equal(res.json.label, 'my rule')
  assert.equal(res.json.enabled, true)
  assert.equal(res.json.target, 'ACCEPT')
  assert.equal(res.json.match.path, '*')
  assert.equal(res.json.match.vessel, '*')
  assert.deepEqual(res.json.match.states, ['alert', 'warn', 'alarm', 'emergency'])
  assert.equal(res.json.targetPathTemplate, 'notifications.received.{path}.dsc-{uuid}')
  h.cleanup()
})

test('rest-api: GET /rules lists created rules', () => {
  const h = createHarness()
  h.call('POST', '/rules', { label: 'a' })
  h.call('POST', '/rules', { label: 'b' })
  const list = h.call('GET', '/rules').json
  assert.equal(list.length, 2)
  h.cleanup()
})

test('rest-api: PUT /rules/:id merges match fields rather than replacing wholesale', () => {
  const h = createHarness()
  const created = h.call('POST', '/rules', { match: { path: 'a.*', vessel: '*' } }).json
  const updated = h.call('PUT', `/rules/${created.id}`, { match: { path: 'b.*' } }).json
  assert.equal(updated.match.path, 'b.*')
  assert.equal(updated.match.vessel, '*', 'unspecified match fields should be preserved')
  h.cleanup()
})

test('rest-api: PUT /rules/:id on unknown id returns 404', () => {
  const h = createHarness()
  const res = h.call('PUT', '/rules/does-not-exist', { label: 'x' })
  assert.equal(res.statusCode, 404)
  h.cleanup()
})

test('rest-api: DELETE /rules/:id removes the rule', () => {
  const h = createHarness()
  const created = h.call('POST', '/rules', {}).json
  h.call('DELETE', `/rules/${created.id}`)
  assert.equal(h.call('GET', '/rules').json.length, 0)
  h.cleanup()
})

test('rest-api: DELETE /rules/:id on unknown id returns 404', () => {
  const h = createHarness()
  const res = h.call('DELETE', '/rules/nope')
  assert.equal(res.statusCode, 404)
  h.cleanup()
})

test('rest-api: PUT /rules bulk-reorders by id array', () => {
  const h = createHarness()
  const a = h.call('POST', '/rules', { label: 'a' }).json
  const b = h.call('POST', '/rules', { label: 'b' }).json
  const c = h.call('POST', '/rules', { label: 'c' }).json

  h.call('PUT', '/rules', [c.id, a.id, b.id])
  const labels = h.call('GET', '/rules').json.map((r) => r.label)
  assert.deepEqual(labels, ['c', 'a', 'b'])
  h.cleanup()
})

test('rest-api: PUT /rules rejects a non-array body', () => {
  const h = createHarness()
  const res = h.call('PUT', '/rules', { not: 'an array' })
  assert.equal(res.statusCode, 400)
  h.cleanup()
})

test('rest-api: every response sets Cache-Control: no-store', () => {
  const h = createHarness()
  h.call('POST', '/rules', { label: 'r' })
  const endpoints = [
    ['GET', '/ruleset'],
    ['GET', '/rules'],
    ['GET', '/policy'],
    ['GET', '/activity'],
  ]
  for (const [method, path] of endpoints) {
    const res = h.call(method, path)
    assert.equal(res.headers['Cache-Control'], 'no-store', `${method} ${path} should be uncacheable`)
  }
  h.cleanup()
})

test('rest-api: GET /activity reflects accept/drop decisions', () => {
  const h = createHarness()
  h.call('POST', '/rules', { label: 'blocker', match: { path: 'urgency.*', vessel: '*' }, target: 'DROP' })

  h.sendDelta({ mmsi: '1', path: 'urgency.test', state: 'alarm' })
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })

  const activity = h.call('GET', '/activity').json
  assert.equal(activity.length, 2)
  // Most recent first.
  assert.equal(activity[0].action, 'accept')
  assert.equal(activity[1].action, 'drop')
  assert.equal(activity[1].rule, 'blocker')
  h.cleanup()
})
