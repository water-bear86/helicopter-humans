import http from 'node:http'
import https from 'node:https'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { assert, Z402Error } from './protocol.js'

function request(url, headers, agent, timeoutMs) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const req = transport.get(url, { agent, headers: { accept: 'application/json', 'user-agent': 'z402/1', ...headers }, maxHeaderSize: 32_768 }, res => {
      const chunks = []; let length = 0
      res.on('data', chunk => {
        length += chunk.length
        if (length > 524_288) req.destroy(new Z402Error('response_too_large'))
        else chunks.push(chunk)
      })
      res.on('error', () => reject(new Z402Error('transport_failed')))
      res.on('end', () => {
        if (length > 524_288) return
        if (res.statusCode >= 300 && res.statusCode < 400) return reject(new Z402Error('redirect_refused'))
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers }))
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Z402Error('transport_timeout')))
    req.on('error', () => reject(new Z402Error('transport_failed')))
  })
}
function normalizedHeaders(headers) {
  assert(headers && Object.keys(headers).every(key => ['z402-request', 'payment-signature'].includes(key)), 'transport_header_refused')
  assert(Object.values(headers).every(value => typeof value === 'string' && value.length <= 24_000 && !/[\r\n]/.test(value)), 'invalid_header')
  return headers
}
export function torTransport({ proxy = 'socks5h://127.0.0.1:9050', timeoutMs = 30_000 } = {}) {
  const endpoint = new URL(proxy)
  assert(endpoint.protocol === 'socks5h:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname) && !endpoint.username && !endpoint.password, 'invalid_tor_proxy')
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000, 'invalid_transport_timeout')
  return async (resource, { headers, purchaseId }) => {
    const url = new URL(resource)
    assert(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 'invalid_resource')
    assert(/^[a-f0-9]{48}$/.test(purchaseId), 'invalid_purchase_id')
    const isolated = new URL(endpoint)
    isolated.username = purchaseId; isolated.password = purchaseId
    // Tor must enable IsolateSOCKSAuth. socks5h leaves destination DNS resolution to Tor.
    const agent = new SocksProxyAgent(isolated)
    try { return await request(url, normalizedHeaders(headers), agent, timeoutMs) }
    finally { agent.destroy() }
  }
}
export function regtestTransport() {
  return (resource, { headers }) => {
    const url = new URL(resource)
    assert(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.hash, 'regtest_loopback_required')
    return request(url, normalizedHeaders(headers), false, 30_000)
  }
}
