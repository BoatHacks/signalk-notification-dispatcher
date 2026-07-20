const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const pluginFactory = require('../index.js')
const { createRouterCapture } = require('../test-support/router-capture')

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skn-migration-'))
}

test('migration: legacy flat rules.json is upgraded to the new ruleset shape on start', () => {
  const dataDir = makeDataDir()
  const legacyRules = [
    {
      id: 'legacy1',
      enabled: true,
      label: 'old suppress rule',
      pathPattern: 'safety.*',
      vesselFilter: '*',
      states: ['alert'],
      action: 'suppress',
      targetPathTemplate: 'notifications.received.{vessel}.{path}',
    },
    {
      id: 'legacy2',
      enabled: true,
      label: 'old forward rule',
      pathPattern: 'navigation.anchor',
      vesselFilter: '211234567',
      action: 'forward',
    },
  ]
  fs.writeFileSync(path.join(dataDir, 'rules.json'), JSON.stringify(legacyRules))

  const app = {
    selfContext: 'vessels.self',
    getDataDirPath: () => dataDir,
    subscriptionmanager: { subscribe: () => {} },
    setPluginStatus: () => {},
    error: () => {},
    handleMessage: () => {},
    getSelfPath: () => undefined,
  }

  const plugin = pluginFactory(app)
  plugin.start({})

  const { router, call } = createRouterCapture()
  plugin.registerWithRouter(router)

  const ruleset = call('GET', '/ruleset').json
  assert.equal(ruleset.policy, 'ACCEPT')
  assert.equal(ruleset.rules.length, 2)

  const migrated1 = ruleset.rules.find((r) => r.id === 'legacy1')
  assert.equal(migrated1.target, 'DROP')
  assert.equal(migrated1.match.path, 'safety.*')
  assert.deepEqual(migrated1.match.states, ['alert'])

  const migrated2 = ruleset.rules.find((r) => r.id === 'legacy2')
  assert.equal(migrated2.target, 'ACCEPT')
  assert.equal(migrated2.match.vessel, '211234567')

  // The migration should have written the new file to disk too.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'ruleset.json'), 'utf8'))
  assert.equal(onDisk.rules.length, 2)

  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('migration: does not run when ruleset.json already exists', () => {
  const dataDir = makeDataDir()
  fs.writeFileSync(path.join(dataDir, 'rules.json'), JSON.stringify([{ id: 'legacy', action: 'suppress' }]))
  fs.writeFileSync(
    path.join(dataDir, 'ruleset.json'),
    JSON.stringify({ policy: 'DROP', rules: [{ id: 'current', match: { path: '*', vessel: '*' }, target: 'ACCEPT' }] })
  )

  const app = {
    selfContext: 'vessels.self',
    getDataDirPath: () => dataDir,
    subscriptionmanager: { subscribe: () => {} },
    setPluginStatus: () => {},
    error: () => {},
    handleMessage: () => {},
    getSelfPath: () => undefined,
  }

  const plugin = pluginFactory(app)
  plugin.start({})
  const { router, call } = createRouterCapture()
  plugin.registerWithRouter(router)

  const ruleset = call('GET', '/ruleset').json
  assert.equal(ruleset.policy, 'DROP', 'existing ruleset.json should win, not the legacy file')
  assert.equal(ruleset.rules[0].id, 'current')

  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('migration: starts with an empty ruleset when neither file exists', () => {
  const dataDir = makeDataDir()
  const app = {
    selfContext: 'vessels.self',
    getDataDirPath: () => dataDir,
    subscriptionmanager: { subscribe: () => {} },
    setPluginStatus: () => {},
    error: () => {},
    handleMessage: () => {},
    getSelfPath: () => undefined,
  }
  const plugin = pluginFactory(app)
  plugin.start({})
  const { router, call } = createRouterCapture()
  plugin.registerWithRouter(router)

  const ruleset = call('GET', '/ruleset').json
  assert.deepEqual(ruleset, { policy: 'ACCEPT', rules: [] })

  fs.rmSync(dataDir, { recursive: true, force: true })
})
