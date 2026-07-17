const test = require('node:test')
const assert = require('node:assert/strict')
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

test('webapp: has no external (CDN) script imports', () => {
  // This is the actual bug this whole test file guards against: an import
  // from a CDN silently aborts the entire module script if the browser has
  // no internet access (very common - this runs against a boat's local
  // SignalK server), leaving a blank page with no visible error. Everything
  // the webapp needs must be vendored under public/vendor/.
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  const script = extractModuleScript(html)
  const importLines = script.match(/^import .*$/gm) || []
  assert.ok(importLines.length > 0, 'expected at least one import statement')
  for (const line of importLines) {
    assert.match(line, /from ['"]\.\//, `import should be a local relative path, got: ${line}`)
  }
})

test('webapp: vendored dependency file exists and has no external imports of its own', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  const script = extractModuleScript(html)
  const importLines = script.match(/from ['"](\.\/[^'"]+)['"]/g) || []
  for (const line of importLines) {
    const relPath = line.match(/from ['"](\.\/[^'"]+)['"]/)[1]
    const abs = path.join(PUBLIC_DIR, relPath)
    assert.ok(fs.existsSync(abs), `vendored file referenced by index.html is missing: ${relPath}`)
    const contents = fs.readFileSync(abs, 'utf8')
    assert.doesNotMatch(contents, /\bfrom\s*["']preact["']/, `${relPath} still has an unresolvable bare "preact" import`)
    assert.doesNotMatch(contents, /https?:\/\/(unpkg|cdn|esm\.sh)/i, `${relPath} still references a CDN`)
  }
})

test('webapp: actually renders content when executed (not a blank page)', async () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  const script = extractModuleScript(html)

  // Write the extracted script next to the real public/ dir (not a copy) so
  // its relative "./vendor/..." import resolves to the real vendored files -
  // this is exactly what a browser loading the real index.html would do.
  const tmpScriptPath = path.join(PUBLIC_DIR, `.webapp-smoke-test-${process.pid}.mjs`)
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
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/ruleset')) return { json: async () => ({ policy: 'ACCEPT', rules: [] }) }
    if (String(url).endsWith('/activity')) return { json: async () => [] }
    return { json: async () => ({}) }
  }
  // The app polls activity via setInterval; capture the id so we can clear
  // it after the assertion instead of leaving a live timer that would keep
  // the test process alive.
  globalThis.setInterval = (...args) => {
    const id = previousSetInterval(...args)
    capturedIntervals.push(id)
    return id
  }

  try {
    await import(`file://${tmpScriptPath}?t=${Date.now()}`)
    // Let the module's top-level render() and its post-render effects flush.
    await new Promise((resolve) => setTimeout(resolve, 300))

    const appEl = dom.window.document.getElementById('app')
    assert.ok(appEl, '#app element should exist')
    assert.ok(appEl.innerHTML.length > 0, 'the app should have rendered content into #app, not stayed blank')
    assert.match(appEl.innerHTML, /Notification Dispatcher/, 'rendered content should include the page header')
  } finally {
    capturedIntervals.forEach(clearInterval)
    globalThis.window = previousWindow
    globalThis.document = previousDocument
    globalThis.fetch = previousFetch
    globalThis.requestAnimationFrame = previousRAF
    globalThis.setInterval = previousSetInterval
    fs.rmSync(tmpScriptPath, { force: true })
  }
})
