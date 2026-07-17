const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')
const { createHarness } = require('../test-support/harness')

const PUBLIC_DIR = path.join(__dirname, '..', 'public')
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html')

function extractModuleScript(html) {
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/)
  if (!match) throw new Error('Could not find <script type="module"> in index.html')
  return match[1]
}

// Regression test for: adding a rule via the "+ Add rule" / "Save rule" flow
// didn't show up in the ruleset JSON editor or the activity panel. Drives
// the webapp's *real* script via real DOM click/input events, with fetch()
// routed into the *real* backend (via the test harness) through a real
// JSON.stringify/parse boundary - as close to a real browser talking to a
// real server as this test suite gets.
test('webapp: a rule added via the modal shows up in the table and the JSON editor', async () => {
  const backend = createHarness()
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  const script = extractModuleScript(html)

  const tmpScriptPath = path.join(PUBLIC_DIR, `.webapp-add-rule-test-${process.pid}.mjs`)
  fs.writeFileSync(tmpScriptPath, script)

  const dom = new JSDOM('<!DOCTYPE html><div id="app"></div>', {
    url: 'http://localhost/plugins/signalk-notification-dispatcher/',
  })

  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousFetch = globalThis.fetch
  const previousRAF = globalThis.requestAnimationFrame
  const previousSetInterval = globalThis.setInterval
  const capturedIntervals = []

  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame
  globalThis.setInterval = (...args) => {
    const id = previousSetInterval(...args)
    capturedIntervals.push(id)
    return id
  }
  // Routes fetch() into the real backend, through a real JSON serialize/
  // deserialize boundary (mirroring an actual network round-trip) rather
  // than handing back a live object reference, which would mask exactly
  // the kind of stale-state bug this test exists to catch.
  globalThis.fetch = async (url, opts) => {
    const u = new URL(url, 'http://localhost')
    const method = (opts && opts.method) || 'GET'
    const body = opts && opts.body ? JSON.parse(opts.body) : undefined
    const result = backend.call(method, u.pathname.replace('/plugins/signalk-notification-dispatcher', ''), body)
    const serialized = JSON.stringify(result.json)
    return { ok: result.statusCode < 400, status: result.statusCode, json: async () => JSON.parse(serialized) }
  }

  try {
    await import(`file://${tmpScriptPath}?t=${Date.now()}`)
    await new Promise((resolve) => setTimeout(resolve, 300))

    const doc = dom.window.document
    const findButtonByText = (text) => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === text)

    findButtonByText('+ Add rule').click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(doc.querySelector('.modal'), 'the rule modal should open')

    const labelInput = doc.querySelector('.modal input[type="text"]')
    labelInput.value = 'regression test rule'
    labelInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    findButtonByText('Save rule').click()
    await new Promise((resolve) => setTimeout(resolve, 300))

    assert.ok(!doc.querySelector('.modal'), 'the modal should close after saving')

    const rows = doc.querySelectorAll('table tbody tr')
    assert.equal(rows.length, 1, 'the new rule should appear in the rule table')
    assert.match(rows[0].textContent, /regression test rule/)

    const textarea = doc.querySelector('.json-editor textarea')
    assert.match(
      textarea.value,
      /regression test rule/,
      'the ruleset JSON editor should reflect the newly-added rule, not a stale/empty ruleset'
    )

    // Confirm the rule is genuinely active on the backend too, not just
    // reflected in stale client state.
    assert.equal(backend.call('GET', '/rules').json.length, 1)
  } finally {
    capturedIntervals.forEach(clearInterval)
    globalThis.window = previousWindow
    globalThis.document = previousDocument
    globalThis.fetch = previousFetch
    globalThis.requestAnimationFrame = previousRAF
    globalThis.setInterval = previousSetInterval
    fs.rmSync(tmpScriptPath, { force: true })
    backend.cleanup()
  }
})
