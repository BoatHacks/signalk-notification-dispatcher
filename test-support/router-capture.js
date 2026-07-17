// A tiny stand-in for an Express router, just enough to capture the routes
// this plugin registers (GET/POST/PUT/DELETE, with a single ":id" param
// supported, and a simple .use() middleware chain) and invoke them directly
// in tests without a real HTTP server.
function createRouterCapture() {
  const routes = { GET: [], POST: [], PUT: [], DELETE: [] }
  const middlewares = []

  const router = {
    get: (p, cb) => routes.GET.push({ pattern: p, cb }),
    post: (p, cb) => routes.POST.push({ pattern: p, cb }),
    put: (p, cb) => routes.PUT.push({ pattern: p, cb }),
    delete: (p, cb) => routes.DELETE.push({ pattern: p, cb }),
    use: (mw) => middlewares.push(mw),
  }

  function matchPattern(pattern, actualPath) {
    const patternParts = pattern.split('/').filter(Boolean)
    const actualParts = actualPath.split('/').filter(Boolean)
    if (patternParts.length !== actualParts.length) return null
    const params = {}
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(':')) {
        params[patternParts[i].slice(1)] = actualParts[i]
      } else if (patternParts[i] !== actualParts[i]) {
        return null
      }
    }
    return params
  }

  function call(method, actualPath, body) {
    for (const { pattern, cb } of routes[method]) {
      const params = matchPattern(pattern, actualPath)
      if (params) {
        let statusCode = 200
        let json = null
        const headers = {}
        const res = {
          status(code) {
            statusCode = code
            return res
          },
          json(payload) {
            json = payload
          },
          set(field, value) {
            headers[field] = value
            return res
          },
        }
        const req = { body, params }

        let i = 0
        function next() {
          if (i < middlewares.length) {
            middlewares[i++](req, res, next)
          } else {
            cb(req, res)
          }
        }
        next()

        return { statusCode, json, headers }
      }
    }
    throw new Error(`No route matches ${method} ${actualPath}`)
  }

  return { router, call }
}

module.exports = { createRouterCapture }
