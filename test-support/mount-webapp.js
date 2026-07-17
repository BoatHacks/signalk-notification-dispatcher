const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const PUBLIC_DIR = path.join(__dirname, '..', 'public')
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html')

function extractModuleScript(html) {
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/)
  if (!match) throw new Error('Could not find <script type="module"> in index.html')
  return match[1]
}

// Mounts the webapp's real script in a jsdom document, with fetch() routed
// into a real backend (via test-support/harness's `call`) through a real
// JSON.stringify/parse boundary - mirroring an actual network round-trip,
// not a live object reference, so this catches the same class of
// stale-state bug a real browser talking to a real server would hit.
//
// Returns { doc, findButtonByText, unmount() }. Always call unmount() in a
// finally block to restore globals and remove the temp script file.
async function mountWebapp(backend, { url = 'http://localhost/plugins/signalk-notification-dispatcher/' } = {}) {
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  const script = extractModuleScript(html)

  const tmpScriptPath = path.join(PUBLIC_DIR, `.webapp-interactive-test-${process.pid}-${Date.now()}.mjs`)
  fs.writeFileSync(tmpScriptPath, script)

  const dom = new JSDOM('<!DOCTYPE html><div id="app"></div>', { url })

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    setInterval: globalThis.setInterval,
  }
  const capturedIntervals = []

  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame
  globalThis.setInterval = (...args) => {
    const id = previous.setInterval(...args)
    capturedIntervals.push(id)
    return id
  }
  globalThis.fetch = async (url, opts) => {
    const u = new URL(url, 'http://localhost')
    const method = (opts && opts.method) || 'GET'
    const body = opts && opts.body ? JSON.parse(opts.body) : undefined
    const result = backend.call(method, u.pathname.replace('/plugins/signalk-notification-dispatcher', ''), body)
    const serialized = JSON.stringify(result.json)
    return { ok: result.statusCode < 400, status: result.statusCode, json: async () => JSON.parse(serialized) }
  }

  await import(`file://${tmpScriptPath}?t=${Date.now()}`)
  await new Promise((resolve) => setTimeout(resolve, 300))

  const doc = dom.window.document
  const findButtonByText = (text) => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === text)

  function unmount() {
    capturedIntervals.forEach(clearInterval)
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.fetch = previous.fetch
    globalThis.requestAnimationFrame = previous.requestAnimationFrame
    globalThis.setInterval = previous.setInterval
    fs.rmSync(tmpScriptPath, { force: true })
  }

  return { doc, findButtonByText, unmount }
}

module.exports = { mountWebapp, PUBLIC_DIR, INDEX_HTML, extractModuleScript }
