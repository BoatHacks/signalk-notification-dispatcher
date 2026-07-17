const pluginFactory = require('../index.js')
const { createFakeApp } = require('./fake-app')
const { createRouterCapture } = require('./router-capture')

// Builds a running instance of the plugin wired to a fake app + router, with
// a sendDelta() helper that drives the internal delta handler the same way
// the real SignalK server would when a notification arrives from another
// vessel.
function createHarness(opts) {
  const fake = createFakeApp(opts)
  const plugin = pluginFactory(fake.app)
  plugin.start({})

  const { router, call } = createRouterCapture()
  plugin.registerWithRouter(router)

  function sendDelta({ mmsi, context, path: notifPath, state, message, timestamp, clear }) {
    const ctx = context || `vessels.urn:mrn:imo:mmsi:${mmsi || '000000000'}`
    const value = clear ? null : { state, message: message || 'test' }
    fake.getDeltaHandler()({
      context: ctx,
      updates: [
        {
          timestamp: timestamp || new Date().toISOString(),
          values: [{ path: `notifications.${notifPath}`, value }],
        },
      ],
    })
  }

  return {
    plugin,
    app: fake.app,
    state: fake.state,
    tmpDir: fake.tmpDir,
    call,
    sendDelta,
    setNavigationState: fake.setNavigationState,
    cleanup: fake.cleanup,
  }
}

module.exports = { createHarness }
