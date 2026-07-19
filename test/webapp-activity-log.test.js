const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('../test-support/harness')
const { mountWebapp } = require('../test-support/mount-webapp')

test('webapp: each activity entry is a collapsible element containing its full JSON', async () => {
  const backend = createHarness()
  backend.call('POST', '/rules', {
    label: 'anchor drag',
    match: { path: 'navigation.anchor', vessel: '*' },
    target: 'ACCEPT',
  })
  backend.sendDelta({ mmsi: '211234567', path: 'navigation.anchor', state: 'alarm', message: 'dragging' })

  const { doc, unmount } = await mountWebapp(backend)

  try {
    // The activity panel is itself a <details>; open it so its content is
    // visible in a real browser (it's present in the DOM either way, but
    // this matches how a person would actually get to it).
    const activityPanel = [...doc.querySelectorAll('details')].find((d) =>
      d.querySelector('summary') && d.querySelector('summary').textContent.includes('Recent activity')
    )
    activityPanel.open = true
    await new Promise((resolve) => setTimeout(resolve, 50))

    const items = doc.querySelectorAll('details.activity-item')
    assert.equal(items.length, 1)

    const item = items[0]
    assert.equal(item.open, false, 'each activity entry should start collapsed')

    const summaryText = item.querySelector('summary').textContent
    assert.match(summaryText, /accept/)
    assert.match(summaryText, /navigation\.anchor/)

    const jsonBlock = item.querySelector('.activity-item-json')
    assert.ok(jsonBlock, 'a JSON block should exist inside the collapsible element')
    const parsed = JSON.parse(jsonBlock.textContent)
    assert.equal(parsed.action, 'accept')
    assert.equal(parsed.sourcePath, 'notifications.navigation.anchor')
    assert.equal(parsed.rule, 'anchor drag')
    assert.equal(parsed.vessel, '211234567')

    // Expanding it should just toggle the native <details> open state.
    item.open = true
    assert.equal(item.open, true)
  } finally {
    unmount()
    backend.cleanup()
  }
})
