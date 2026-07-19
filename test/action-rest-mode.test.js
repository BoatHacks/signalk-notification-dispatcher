const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { createHarness } = require('../test-support/harness')

// Spins up a tiny local HTTP server capturing every request it receives
// (method, url, headers, parsed JSON body if any), so ACTION's 'rest' mode
// can be exercised against something real rather than a mocked fetch.
function startTestServer(responder) {
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      let parsedBody = null
      if (body) {
        try {
          parsedBody = JSON.parse(body)
        } catch (err) {
          parsedBody = body
        }
      }
      received.push({ method: req.method, url: req.url, headers: req.headers, body: parsedBody })
      const { status, payload } = responder ? responder(req, parsedBody) : { status: 200, payload: { ok: true } }
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        received,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

test('action: rest mode GET calls the resolved URL with no body', async () => {
  const srv = await startTestServer()
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'navigation.anchor', vessel: '*' },
    target: 'ACTION',
    action: { mode: 'rest', path: `${srv.baseUrl}/hook/{path}`, method: 'GET' },
  })
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal(srv.received.length, 1)
  assert.equal(srv.received[0].method, 'GET')
  assert.equal(srv.received[0].url, '/hook/navigation.anchor')
  assert.equal(srv.received[0].body, null, 'GET should not send a body')

  await srv.close()
  h.cleanup()
})

test('action: rest mode POST sends the resolved value as a JSON body', async () => {
  const srv = await startTestServer()
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'urgency.*', vessel: '*' },
    target: 'ACTION',
    action: {
      mode: 'rest',
      path: `${srv.baseUrl}/hook`,
      method: 'POST',
      value: '{"vessel":"{vessel}","state":"{state}"}',
    },
  })
  h.sendDelta({ mmsi: '211234567', path: 'urgency.test', state: 'alarm' })
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal(srv.received.length, 1)
  assert.equal(srv.received[0].method, 'POST')
  assert.equal(srv.received[0].headers['content-type'], 'application/json')
  assert.deepEqual(srv.received[0].body, { vessel: '211234567', state: 'alarm' })

  await srv.close()
  h.cleanup()
})

test('action: rest mode PUT with a whole-placeholder body sends the referenced value directly', async () => {
  const srv = await startTestServer()
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'safety.*', vessel: '*' },
    target: 'ACTION',
    action: { mode: 'rest', path: `${srv.baseUrl}/status`, method: 'PUT', value: '{status.isAcknowledged}' },
  })
  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'warn', extra: { status: { isAcknowledged: true } } })
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal(srv.received[0].method, 'PUT')
  assert.equal(srv.received[0].body, true)

  await srv.close()
  h.cleanup()
})

test('action: rest mode defaults to GET when method is omitted/invalid', async () => {
  const srv = await startTestServer()
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'navigation.anchor', vessel: '*' },
    target: 'ACTION',
    action: { mode: 'rest', path: srv.baseUrl },
  })
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(srv.received[0].method, 'GET')

  await srv.close()
  h.cleanup()
})

test('action: rest mode a non-2xx response logs an action-error', async () => {
  const srv = await startTestServer(() => ({ status: 500, payload: { error: 'boom' } }))
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'navigation.anchor', vessel: '*' },
    target: 'ACTION',
    action: { mode: 'rest', path: srv.baseUrl, method: 'GET' },
  })
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })
  await new Promise((resolve) => setTimeout(resolve, 150))

  const activity = h.call('GET', '/activity').json
  assert.equal(activity[0].action, 'action-error')
  assert.match(activity[0].error, /HTTP 500/)

  await srv.close()
  h.cleanup()
})

test('action: rest mode an unreachable URL logs an action-error rather than crashing', async () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'navigation.anchor', vessel: '*' },
    target: 'ACTION',
    action: { mode: 'rest', path: 'http://127.0.0.1:1', method: 'GET' },
  })
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })
  await new Promise((resolve) => setTimeout(resolve, 200))

  const activity = h.call('GET', '/activity').json
  assert.equal(activity[0].action, 'action-error')
  h.cleanup()
})

test('action: rest mode does not use handleMessage or putSelfPath', async () => {
  const srv = await startTestServer()
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: 'navigation.anchor', vessel: '*' },
    target: 'ACTION',
    action: { mode: 'rest', path: srv.baseUrl, method: 'GET' },
  })
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal(h.state.forwarded.length, 0)
  assert.equal(h.state.putCalls.length, 0)

  await srv.close()
  h.cleanup()
})

test('action: rest mode activity log includes actionMode/actionPath/actionValue', async () => {
  const srv = await startTestServer()
  const h = createHarness()
  h.call('POST', '/rules', {
    label: 'webhook',
    match: { path: 'navigation.anchor', vessel: '*' },
    target: 'ACTION',
    action: { mode: 'rest', path: `${srv.baseUrl}/hook`, method: 'POST', value: 'true' },
  })
  h.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })
  await new Promise((resolve) => setTimeout(resolve, 100))

  const activity = h.call('GET', '/activity').json
  assert.equal(activity[0].action, 'action')
  assert.equal(activity[0].rule, 'webhook')
  assert.equal(activity[0].actionMode, 'rest')
  assert.equal(activity[0].actionPath, `${srv.baseUrl}/hook`)
  assert.equal(activity[0].actionValue, true)

  await srv.close()
  h.cleanup()
})

test('action: sanitizeRule defaults method to GET and accepts rest as a mode', () => {
  const h = createHarness()
  const created = h.call('POST', '/rules', { target: 'ACTION', action: { mode: 'rest', path: 'http://x' } }).json
  assert.equal(created.action.mode, 'rest')
  assert.equal(created.action.method, 'GET')
  h.cleanup()
})

test('action: sanitizeRule rejects an invalid method, falling back to GET', () => {
  const h = createHarness()
  const created = h.call('POST', '/rules', { target: 'ACTION', action: { mode: 'rest', method: 'DELETE' } }).json
  assert.equal(created.action.method, 'GET')
  h.cleanup()
})
