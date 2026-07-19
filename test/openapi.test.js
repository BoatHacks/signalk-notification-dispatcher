const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('../test-support/harness')

test('getOpenApi() documents exactly the routes registerWithRouter exposes', () => {
  const h = createHarness()
  const spec = h.plugin.getOpenApi()

  assert.equal(spec.openapi, '3.0.3')
  assert.deepEqual(
    Object.keys(spec.paths).sort(),
    ['/activity', '/paths', '/policy', '/ruleset', '/rules', '/rules/{id}'].sort()
  )

  assert.ok(spec.paths['/ruleset'].get)
  assert.ok(spec.paths['/ruleset'].put)
  assert.ok(spec.paths['/policy'].get)
  assert.ok(spec.paths['/policy'].put)
  assert.ok(spec.paths['/rules'].get)
  assert.ok(spec.paths['/rules'].post)
  assert.ok(spec.paths['/rules'].put, 'PUT /rules (bulk reorder) should be documented')
  assert.ok(spec.paths['/rules/{id}'].put)
  assert.ok(spec.paths['/rules/{id}'].delete)
  assert.ok(spec.paths['/activity'].get)
  assert.ok(spec.paths['/paths'].get)

  // The API is mounted under /plugins/<id>, not at the SignalK API root -
  // per SignalK's documented convention, that means a `servers` entry is
  // required or the docs would present the wrong base path.
  assert.equal(spec.servers[0].url, '/plugins/signalk-notification-dispatcher')

  h.cleanup()
})

test('getOpenApi() every $ref resolves to an existing component schema', () => {
  const h = createHarness()
  const spec = h.plugin.getOpenApi()
  const schemas = spec.components.schemas

  function walk(node) {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node && typeof node === 'object') {
      if (typeof node.$ref === 'string') {
        const match = node.$ref.match(/^#\/components\/schemas\/(.+)$/)
        assert.ok(match, `unexpected $ref format: ${node.$ref}`)
        assert.ok(schemas[match[1]], `$ref points at a schema that doesn't exist: ${node.$ref}`)
      }
      Object.values(node).forEach(walk)
    }
  }

  walk(spec.paths)
  walk(schemas)
  h.cleanup()
})

test('getOpenApi() info.version matches package.json', () => {
  const h = createHarness()
  const spec = h.plugin.getOpenApi()
  const pkg = require('../package.json')
  assert.equal(spec.info.version, pkg.version)
  h.cleanup()
})
