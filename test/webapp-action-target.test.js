const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('../test-support/harness')
const { mountWebapp } = require('../test-support/mount-webapp')

test('webapp: creating an ACTION rule via the modal saves the expected shape and takes effect', async () => {
  const backend = createHarness({ knownPaths: ['electrical.switches.anchorLight.state', 'navigation.position'] })
  const { doc, findButtonByText, unmount } = await mountWebapp(backend)

  try {
    findButtonByText('+ Add rule').click()
    await new Promise((resolve) => setTimeout(resolve, 100))

    const targetSelect = doc.querySelector('.modal select')
    targetSelect.value = 'ACTION'
    targetSelect.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    // The known-paths datalist should be populated for the path picker.
    const datalist = doc.querySelector('#known-paths-datalist')
    assert.ok(datalist, 'the known-paths datalist should exist once ACTION is selected')
    const options = [...datalist.querySelectorAll('option')].map((o) => o.value)
    assert.deepEqual(options, ['electrical.switches.anchorLight.state', 'navigation.position'])

    const pathInput = doc.querySelector('input[list="known-paths-datalist"]')
    pathInput.value = 'electrical.switches.anchorLight.state'
    pathInput.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    const valueInput = [...doc.querySelectorAll('.modal input[type="text"]')].find((el) =>
      (el.getAttribute('placeholder') || '').includes('{state}')
    )
    assert.ok(valueInput, 'the value input should exist')
    valueInput.value = 'true'
    valueInput.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    findButtonByText('Save rule').click()
    await new Promise((resolve) => setTimeout(resolve, 300))

    const saved = backend.call('GET', '/rules').json[0]
    assert.equal(saved.target, 'ACTION')
    assert.equal(saved.action.mode, 'delta')
    assert.equal(saved.action.path, 'electrical.switches.anchorLight.state')
    assert.equal(saved.action.value, 'true')
    assert.equal(saved.action.forward, false)

    // Confirm it's genuinely wired up on the backend, not just saved as data.
    backend.sendDelta({ mmsi: '1', path: 'navigation.anchor', state: 'alarm' })
    const written = backend.state.forwarded.find((d) => d.updates[0].values[0].path === 'electrical.switches.anchorLight.state')
    assert.ok(written, 'the ACTION rule should actually write on a matching notification')
    assert.equal(written.updates[0].values[0].value, true)

    assert.match(doc.querySelector('table tbody tr').textContent, /ACTION/)
  } finally {
    unmount()
    backend.cleanup()
  }
})

test('webapp: toggling "also forward" for an ACTION rule shows the target path template field', async () => {
  const backend = createHarness()
  const { doc, findButtonByText, unmount } = await mountWebapp(backend)

  try {
    findButtonByText('+ Add rule').click()
    await new Promise((resolve) => setTimeout(resolve, 100))

    const targetSelect = doc.querySelector('.modal select')
    targetSelect.value = 'ACTION'
    targetSelect.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.equal(
      [...doc.querySelectorAll('.modal label')].some((l) => l.textContent.includes('Target path template')),
      false,
      'target path template should be hidden until "also forward" is checked'
    )

    const forwardCheckbox = [...doc.querySelectorAll('.modal input[type="checkbox"]')].find((c) =>
      c.closest('label').textContent.includes('Also forward this notification')
    )
    assert.ok(forwardCheckbox)
    forwardCheckbox.click()
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.equal(
      [...doc.querySelectorAll('.modal label')].some((l) => l.textContent.includes('Target path template')),
      true,
      'target path template should appear once "also forward" is checked'
    )
  } finally {
    unmount()
    backend.cleanup()
  }
})

test('webapp: selecting rest mode shows the HTTP method field and relabels path/value, and saves correctly', async () => {
  const backend = createHarness()
  const { doc, findButtonByText, unmount } = await mountWebapp(backend)

  try {
    findButtonByText('+ Add rule').click()
    await new Promise((resolve) => setTimeout(resolve, 100))

    const selects = () => [...doc.querySelectorAll('.modal select')]
    const targetSelect = selects()[0]
    targetSelect.value = 'ACTION'
    targetSelect.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Second select in the modal is now "Write mode".
    const modeSelect = selects()[1]
    modeSelect.value = 'rest'
    modeSelect.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    const labelTexts = () => [...doc.querySelectorAll('.modal label')].map((l) => l.textContent)
    assert.ok(labelTexts().some((t) => t.includes('HTTP method')), 'HTTP method field should appear for rest mode')
    assert.ok(labelTexts().some((t) => t.includes('URL to call')), 'path field should be relabeled to URL to call')
    assert.ok(
      labelTexts().some((t) => t.includes('Request body')),
      'value field should be relabeled to Request body'
    )
    assert.equal(
      doc.querySelector('input[list="known-paths-datalist"]'),
      null,
      'the Signal K path datalist should not be shown for rest mode'
    )

    // Third select is now "HTTP method" (after Target and Write mode).
    const methodSelect = selects()[2]
    methodSelect.value = 'POST'
    methodSelect.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    const textInputs = [...doc.querySelectorAll('.modal input[type="text"]')]
    const urlInput = textInputs.find((el) => el.getAttribute('placeholder') === 'https://example.com/hook/{path}')
    const bodyInput = textInputs.find((el) => (el.getAttribute('placeholder') || '').includes('{state}'))
    assert.ok(urlInput && bodyInput)

    urlInput.value = 'http://127.0.0.1:9/webhook'
    urlInput.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    bodyInput.value = '{"state":"{state}"}'
    bodyInput.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    findButtonByText('Save rule').click()
    await new Promise((resolve) => setTimeout(resolve, 300))

    const saved = backend.call('GET', '/rules').json[0]
    assert.equal(saved.action.mode, 'rest')
    assert.equal(saved.action.method, 'POST')
    assert.equal(saved.action.path, 'http://127.0.0.1:9/webhook')
    assert.equal(saved.action.value, '{"state":"{state}"}')
  } finally {
    unmount()
    backend.cleanup()
  }
})
