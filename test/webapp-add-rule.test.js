const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('../test-support/harness')
const { mountWebapp } = require('../test-support/mount-webapp')

// Regression test for: adding a rule via the "+ Add rule" / "Save rule" flow
// didn't show up in the ruleset JSON editor or the activity panel.
test('webapp: a rule added via the modal shows up in the table and the JSON editor', async () => {
  const backend = createHarness()
  const { doc, findButtonByText, unmount } = await mountWebapp(backend)

  try {
    findButtonByText('+ Add rule').click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(doc.querySelector('.modal'), 'the rule modal should open')

    const labelInput = doc.querySelector('.modal input[type="text"]')
    labelInput.value = 'regression test rule'
    labelInput.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }))
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

    assert.equal(backend.call('GET', '/rules').json.length, 1)
  } finally {
    unmount()
    backend.cleanup()
  }
})

test('webapp: the "always accept nominal/normal" checkbox in the Add rule modal is saved and takes effect', async () => {
  const backend = createHarness()
  const { doc, findButtonByText, unmount } = await mountWebapp(backend)

  try {
    findButtonByText('+ Add rule').click()
    await new Promise((resolve) => setTimeout(resolve, 100))

    const checkboxes = [...doc.querySelectorAll('.modal input[type="checkbox"]')]
    const normalCheckbox = checkboxes.find(
      (c) => c.closest('label').textContent.includes('Always accept state changes to nominal/normal')
    )
    assert.ok(normalCheckbox, 'the checkbox should be present in the modal')
    assert.equal(normalCheckbox.checked, false)

    normalCheckbox.click()
    await new Promise((resolve) => setTimeout(resolve, 50))

    findButtonByText('Save rule').click()
    await new Promise((resolve) => setTimeout(resolve, 300))

    const saved = backend.call('GET', '/rules').json[0]
    assert.equal(saved.match.alwaysAcceptNormal, true)

    assert.match(
      doc.querySelector('table tbody tr').textContent,
      /nominal\/normal/,
      'the rule table should indicate the option is enabled'
    )
  } finally {
    unmount()
    backend.cleanup()
  }
})
