const fs = require('fs')
const os = require('os')
const path = require('path')

// Creates a minimal fake of the SignalK plugin `app` object, enough to
// exercise this plugin's start()/stop()/registerWithRouter() and the delta
// handler it subscribes internally. Each instance gets its own throwaway
// data directory so tests never share state or touch a real SignalK install.
function createFakeApp({ navigationState, knownPaths = [], putSelfPathImpl } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skn-test-'))
  let deltaHandler = null
  let currentNavState = navigationState

  const state = {
    forwarded: [],
    statusMessages: [],
    errors: [],
    putCalls: [],
  }

  const app = {
    selfContext: 'vessels.self',
    getDataDirPath: () => tmpDir,
    subscriptionmanager: {
      subscribe: (opts, unsubscribes, errCb, cb) => {
        deltaHandler = cb
      },
    },
    setPluginStatus: (msg) => state.statusMessages.push(msg),
    error: (msg) => state.errors.push(msg),
    handleMessage: (id, delta) => state.forwarded.push(delta),
    getSelfPath: (p) => {
      if (p !== 'navigation.state') return undefined
      return currentNavState === undefined ? undefined : { value: currentNavState }
    },
    putSelfPath: async (aPath, value, updateCb) => {
      state.putCalls.push({ path: aPath, value })
      const result = putSelfPathImpl ? await putSelfPathImpl(aPath, value) : undefined
      updateCb()
      return result
    },
    streambundle: {
      getAvailablePaths: () => knownPaths,
    },
  }

  return {
    app,
    tmpDir,
    state,
    setNavigationState(value) {
      currentNavState = value
    },
    getDeltaHandler: () => deltaHandler,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  }
}

module.exports = { createFakeApp }
