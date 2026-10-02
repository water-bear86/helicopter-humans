import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { assert, canonical, object, Z402Error } from './protocol.js'

export class NativeWallet {
  constructor({ binary, configFile, timeoutMs = 600_000 }) {
    assert(isAbsolute(binary) && isAbsolute(configFile), 'native_paths_must_be_absolute')
    assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 900_000, 'invalid_native_timeout')
    this.binary = binary; this.configFile = configFile; this.timeoutMs = timeoutMs
  }
  call(command, input = {}) {
    assert(['preflight', 'init', 'sync', 'address', 'propose', 'sign', 'submit', 'disclose', 'verify'].includes(command), 'invalid_native_command')
    const bytes = canonical(input)
    assert(Buffer.byteLength(bytes) <= 4_194_304, 'native_input_too_large')
    return new Promise((resolve, reject) => {
      // Sensitive protocol material travels over stdin, never argv, env, or a shell.
      const child = spawn(this.binary, ['--config', this.configFile, command], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH, RUST_LOG: 'off' } })
      const chunks = []; let length = 0, completed = false
      const finish = (error, response) => {
        if (completed) return
        completed = true; clearTimeout(timer)
        if (error) { child.kill('SIGKILL'); reject(error) } else resolve(response)
      }
      const timer = setTimeout(() => finish(new Z402Error('native_timeout')), this.timeoutMs)
      child.on('error', () => finish(new Z402Error('native_unavailable')))
      child.stdin.on('error', () => finish(new Z402Error('native_input_failed')))
      child.stdout.on('data', chunk => {
        length += chunk.length
        if (length > 4_194_304) return finish(new Z402Error('native_output_too_large'))
        chunks.push(chunk)
      })
      child.on('close', code => {
        if (completed) return
        try {
          const response = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          assert(code === 0 && object(response) && response.ok === true && object(response.result), 'native_refused')
          finish(undefined, response.result)
        } catch { finish(new Z402Error(`native_${command}_refused`)) }
      })
      child.stdin.end(bytes)
    })
  }
  preflight() { return this.call('preflight') }
  propose(input) { return this.call('propose', input) }
  sign(input) { return this.call('sign', input) }
  submit(input) { return this.call('submit', input) }
  disclose(input) { return this.call('disclose', input) }
  verify(input) { return this.call('verify', input) }
}
