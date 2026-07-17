const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('../test-support/harness')
const { mountWebapp } = require('../test-support/mount-webapp')

test('webapp: changing the default policy dropdown is reflected in the JSON editor', async () => {
  const backend = createHarness()
  const { doc, unmount } = await mountWebapp(backend)

  try {
    const policySelect = doc.querySelector('.policy-control select')
    assert.ok(policySelect, 'default policy dropdown should exist')
    assert.equal(policySelect.value, 'ACCEPT')

    policySelect.value = 'DROP'
    policySelect.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 300))

    assert.equal(backend.call('GET', '/policy').json.policy, 'DROP', 'backend policy should have changed')

    const textarea = doc.querySelector('.json-editor textarea')
    assert.match(textarea.value, /"policy":\s*"DROP"/, 'JSON editor should reflect the new default policy')
  } finally {
    unmount()
    backend.cleanup()
  }
})

test('webapp: "Apply ruleset" in the JSON editor actually applies the edited ruleset', async () => {
  const backend = createHarness()
  const { doc, findButtonByText, unmount } = await mountWebapp(backend)

  try {
    const textarea = doc.querySelector('.json-editor textarea')
    const edited = JSON.stringify(
      {
        policy: 'DROP',
        rules: [{ label: 'applied via editor', match: { path: 'test.*', vessel: '*' }, target: 'ACCEPT' }],
      },
      null,
      2
    )
    textarea.value = edited
    textarea.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    const applyBtn = findButtonByText('Apply ruleset')
    assert.ok(applyBtn, '"Apply ruleset" button should exist')
    applyBtn.click()
    await new Promise((resolve) => setTimeout(resolve, 300))

    const backendRuleset = backend.call('GET', '/ruleset').json
    assert.equal(backendRuleset.policy, 'DROP', 'the edited policy should have been applied to the backend')
    assert.equal(backendRuleset.rules.length, 1)
    assert.equal(backendRuleset.rules[0].label, 'applied via editor')

    const rows = doc.querySelectorAll('table tbody tr')
    assert.equal(rows.length, 1, 'the rule table should reflect the applied ruleset')
    assert.match(rows[0].textContent, /applied via editor/)

    const policySelect = doc.querySelector('.policy-control select')
    assert.equal(policySelect.value, 'DROP', 'the policy dropdown should also reflect the applied ruleset')
  } finally {
    unmount()
    backend.cleanup()
  }
})

test('webapp: requests go to /plugins/<id> even when the webapp itself is served at a completely different path', async () => {
  // This is the exact bug reported: the webapp (via the signalk-webapp
  // convention) is served at /signalk-notification-dispatcher/, but the
  // plugin's REST API (registerWithRouter) is documented to always live at
  // /plugins/signalk-notification-dispatcher/ - a different path, not just
  // a trailing-slash variant. The fetch base must not be derived from
  // wherever this page happens to be hosted.
  const backend = createHarness()
  const { doc, findButtonByText, unmount } = await mountWebapp(backend, {
    url: 'http://signalk-server:3000/signalk-notification-dispatcher/',
  })

  try {
    findButtonByText('+ Add rule').click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const labelInput = doc.querySelector('.modal input[type="text"]')
    labelInput.value = 'wrong base path rule'
    labelInput.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    findButtonByText('Save rule').click()
    await new Promise((resolve) => setTimeout(resolve, 300))

    assert.equal(backend.call('GET', '/rules').json.length, 1, 'the save should have reached /plugins/<id>/rules')
    assert.equal(doc.querySelector('.error-banner'), null, 'no error banner should be shown')
  } finally {
    unmount()
    backend.cleanup()
  }
})

test('webapp: fetch base URL is unaffected by a later location change (e.g. a surrounding SPA shell navigating)', async () => {
  const backend = createHarness()
  const { doc, findButtonByText, unmount } = await mountWebapp(backend)

  try {
    // Simulate something else in the page (e.g. the SignalK admin UI's own
    // client-side router, if this webapp isn't isolated in its own iframe)
    // changing the URL after our script has already loaded. Since BASE is a
    // fixed absolute path rather than derived from window.location, this
    // should have no effect at all.
    doc.defaultView.history.pushState({}, '', 'http://localhost/admin/#/somewhere/else')

    findButtonByText('+ Add rule').click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const labelInput = doc.querySelector('.modal input[type="text"]')
    labelInput.value = 'post-navigation rule'
    labelInput.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    findButtonByText('Save rule').click()
    await new Promise((resolve) => setTimeout(resolve, 300))

    assert.equal(backend.call('GET', '/rules').json.length, 1, 'the save should still have reached the backend')
    assert.equal(doc.querySelector('.error-banner'), null, 'no error banner should be shown')
  } finally {
    unmount()
    backend.cleanup()
  }
})

test('webapp: a failed request shows a visible error instead of failing silently', async () => {
  const backend = createHarness()
  const { doc, unmount } = await mountWebapp(backend)

  try {
    // Simulate the exact failure mode this bug report was tracing: fetch()
    // resolving to a 404 (e.g. from a wrong base URL) rather than throwing.
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, opts) => {
      if (opts && opts.method === 'PUT' && String(url).endsWith('/policy')) {
        return { ok: false, status: 404, url: String(url), json: async () => ({}) }
      }
      return realFetch(url, opts)
    }

    const policySelect = doc.querySelector('.policy-control select')
    policySelect.value = 'DROP'
    policySelect.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 200))

    const banner = doc.querySelector('.error-banner')
    assert.ok(banner, 'a failed request should show a visible error banner, not fail silently')
    assert.match(banner.textContent, /404/)
  } finally {
    unmount()
    backend.cleanup()
  }
})

test('webapp: "Validate" in the JSON editor reports errors without applying anything', async () => {
  const backend = createHarness()
  const { doc, findButtonByText, unmount } = await mountWebapp(backend)

  try {
    const textarea = doc.querySelector('.json-editor textarea')
    textarea.value = '{ not valid json'
    textarea.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    findButtonByText('Validate').click()
    await new Promise((resolve) => setTimeout(resolve, 100))

    assert.ok(doc.querySelector('.json-editor-error'), 'an error message should be shown for invalid JSON')
    assert.equal(backend.call('GET', '/ruleset').json.rules.length, 0, 'nothing should have been applied')
  } finally {
    unmount()
    backend.cleanup()
  }
})
