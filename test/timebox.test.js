const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('../test-support/harness')

test('timebox: HH:MM anchor matches within tolerance, not outside it', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: {
      path: 'safety.*',
      vessel: '*',
      timebox: { enabled: true, times: ['02:15'], toleranceMinutes: 5 },
    },
    target: 'DROP',
  })

  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'warn', timestamp: '2026-07-16T02:19:00Z' })
  assert.equal(h.state.forwarded.length, 0, 'within tolerance should match and drop')

  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'warn', timestamp: '2026-07-16T02:21:00Z' })
  assert.equal(h.state.forwarded.length, 1, 'outside tolerance should not match, falls through to ACCEPT')
  h.cleanup()
})

test('timebox: handles midnight wraparound', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: {
      path: '*',
      vessel: '*',
      timebox: { enabled: true, times: ['00:00'], toleranceMinutes: 5 },
    },
    target: 'DROP',
  })

  h.sendDelta({ mmsi: '1', path: 'safety.test', state: 'warn', timestamp: '2026-07-16T23:58:00Z' })
  assert.equal(h.state.forwarded.length, 0, '23:58 should be within 5 minutes of the next midnight')
  h.cleanup()
})

test('timebox: multiple HH:MM anchors, e.g. a broadcast schedule', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: {
      path: 'safety.*',
      vessel: '*',
      timebox: {
        enabled: true,
        times: ['02:15', '06:15', '10:15', '14:15', '18:15', '22:15'],
        toleranceMinutes: 5,
      },
    },
    target: 'DROP',
  })

  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'warn', timestamp: '2026-07-16T14:12:00Z' })
  assert.equal(h.state.forwarded.length, 0)

  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'warn', timestamp: '2026-07-16T09:15:00Z' })
  assert.equal(h.state.forwarded.length, 1, '09:15 is not one of the anchors')
  h.cleanup()
})

test('timebox: disabled timebox always matches (no time restriction)', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: '*', vessel: '*', timebox: { enabled: false, times: ['02:15'], toleranceMinutes: 5 } },
    target: 'DROP',
  })
  h.sendDelta({ mmsi: '1', path: 'safety.test', state: 'warn', timestamp: '2026-07-16T12:00:00Z' })
  assert.equal(h.state.forwarded.length, 0)
  h.cleanup()
})

test('timebox: crontab expert-mode entry (field list) matches the documented schedule', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: {
      path: 'safety.*',
      vessel: '*',
      timebox: { enabled: true, times: ['15 2,6,10,14,18,22 * * *'], toleranceMinutes: 5 },
    },
    target: 'DROP',
  })

  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'warn', timestamp: '2026-07-16T02:19:00Z' })
  assert.equal(h.state.forwarded.length, 0)

  h.sendDelta({ mmsi: '1', path: 'safety.securite', state: 'warn', timestamp: '2026-07-16T09:15:00Z' })
  assert.equal(h.state.forwarded.length, 1)
  h.cleanup()
})

test('timebox: crontab weekday restriction', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: {
      path: '*',
      vessel: '*',
      // Every Sunday at 08:00 UTC
      timebox: { enabled: true, times: ['0 8 * * 0'], toleranceMinutes: 2 },
    },
    target: 'DROP',
  })

  // 2026-07-19 is a Sunday
  h.sendDelta({ mmsi: '1', path: 'safety.test', state: 'warn', timestamp: '2026-07-19T08:00:00Z' })
  assert.equal(h.state.forwarded.length, 0)

  // 2026-07-20 is a Monday
  h.sendDelta({ mmsi: '1', path: 'safety.test', state: 'warn', timestamp: '2026-07-20T08:00:00Z' })
  assert.equal(h.state.forwarded.length, 1)
  h.cleanup()
})

test('timebox: crontab step values (*/15)', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: { path: '*', vessel: '*', timebox: { enabled: true, times: ['*/15 * * * *'], toleranceMinutes: 0 } },
    target: 'DROP',
  })

  h.sendDelta({ mmsi: '1', path: 'safety.a', state: 'warn', timestamp: '2026-07-16T05:00:00Z' })
  assert.equal(h.state.forwarded.length, 0)

  h.sendDelta({ mmsi: '1', path: 'safety.b', state: 'warn', timestamp: '2026-07-16T05:07:00Z' })
  assert.equal(h.state.forwarded.length, 1)

  h.sendDelta({ mmsi: '1', path: 'safety.c', state: 'warn', timestamp: '2026-07-16T05:15:00Z' })
  assert.equal(h.state.forwarded.length, 1, 'still 1 - the :15 mark should also match and drop')
  h.cleanup()
})

test('timebox: simple HH:MM and crontab entries can be mixed in the same rule', () => {
  const h = createHarness()
  h.call('POST', '/rules', {
    match: {
      path: '*',
      vessel: '*',
      timebox: { enabled: true, times: ['02:15', '0 8 * * 0'], toleranceMinutes: 5 },
    },
    target: 'DROP',
  })

  h.sendDelta({ mmsi: '1', path: 'safety.a', state: 'warn', timestamp: '2026-07-16T02:16:00Z' })
  assert.equal(h.state.forwarded.length, 0, 'simple entry should match')

  h.sendDelta({ mmsi: '1', path: 'safety.b', state: 'warn', timestamp: '2026-07-19T08:02:00Z' })
  assert.equal(h.state.forwarded.length, 0, 'cron entry should also match')

  h.sendDelta({ mmsi: '1', path: 'safety.c', state: 'warn', timestamp: '2026-07-16T12:00:00Z' })
  assert.equal(h.state.forwarded.length, 1, 'neither entry matches, falls through')
  h.cleanup()
})
