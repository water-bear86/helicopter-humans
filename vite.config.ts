import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ViteDevServer } from 'vite'
import { defineConfig } from 'vitest/config'

// Dev server only: serves api/checkout/* and api/status through the real function modules when
// CHECKOUT_MODE=fixture, so the checkout preview can be exercised locally. Never part of a build.
const API_ROUTES: Record<string, string> = {
  '/api/checkout/orders': '/api/checkout/orders.ts',
  '/api/checkout/order': '/api/checkout/order.ts',
  '/api/status': '/api/status.ts',
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  return new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined })
}

function checkoutFixtureApi(): Plugin {
  return {
    name: 'checkout-fixture-api',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      if (process.env.CHECKOUT_MODE !== 'fixture') return
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const file = API_ROUTES[(req.url ?? '').split('?')[0]]
        if (!file) return next()
        // Loopback Host only, so a rebinding DNS name cannot pass the same-origin check.
        if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host ?? '')) {
          res.statusCode = 403
          return res.end()
        }
        try {
          const mod = (await server.ssrLoadModule(file)) as Record<string, (request: Request) => Response | Promise<Response>>
          const handler = mod[req.method ?? 'GET']
          if (!handler) {
            res.statusCode = 405
            return res.end()
          }
          const response = await handler(await toRequest(req))
          res.statusCode = response.status
          response.headers.forEach((value, key) => res.setHeader(key, value))
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch {
          res.statusCode = 500
          res.end()
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [checkoutFixtureApi()],
  build: {
    rollupOptions: {
      input: { main: 'index.html', checkout: 'checkout.html' },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
