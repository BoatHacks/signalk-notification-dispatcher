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
