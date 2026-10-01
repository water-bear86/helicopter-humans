import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { torTransport, nonce } from '../index.js'

test('SOCKS carries remote DNS and isolates credentials by purchase without fallback', async () => {
  const sessions = []
  const server = createServer(socket => {
    let stage = 0, pending = Buffer.alloc(0), session
    socket.on('data',bytes => {
      pending = Buffer.concat([pending,bytes])
      if(stage === 0 && pending.length >= 2 + pending[1]) {
        assert.equal(pending[0],5); assert.ok(pending.subarray(2,2+pending[1]).includes(2))
        pending = pending.subarray(2+pending[1]); socket.write(Buffer.from([5,2])); stage = 1
      }
      if(stage === 1 && pending.length >= 3+pending[1]) {
        const end = 2+pending[1], total = end+1+pending[end]
        if(pending.length < total) return
        session = {username:pending.subarray(2,end).toString(),password:pending.subarray(end+1,total).toString()}
        pending = pending.subarray(total); socket.write(Buffer.from([1,0])); stage = 2
      }
      if(stage === 2 && pending.length >= 5+pending[4]+2) {
        assert.equal(pending[3],3,'destination must be sent to SOCKS as a domain')
        session.hostname = pending.subarray(5,5+pending[4]).toString(); sessions.push(session)
        // Refuse the tunnel: the client must propagate failure without connecting directly.
        socket.end(Buffer.from([5,5,0,1,0,0,0,0,0,0])); stage = 3
      }
    })
  })
  server.listen(0,'127.0.0.1'); await once(server,'listening')
  try {
    const send = torTransport({proxy:`socks5h://127.0.0.1:${server.address().port}`,timeoutMs:1000})
    const a = nonce(), b = nonce()
    for(const purchaseId of [a,a,b]) await assert.rejects(send('https://unresolvable-z402.test/report',{headers:{},purchaseId}),/transport_failed/)
    assert.deepEqual(sessions.map(session => session.username),[a,a,b])
    assert.ok(sessions.every(session => session.password === session.username && session.hostname === 'unresolvable-z402.test'))
  } finally { await new Promise(resolve => server.close(resolve)) }
})
