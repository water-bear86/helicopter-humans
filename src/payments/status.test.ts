import { describe, expect, it } from 'vitest'
import { GET } from '../../api/status'

describe('GET /api/status', () => {
  it('reports the disabled adapter by default and is not cached', async () => {
    const res = GET()
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ payments: { adapter: 'disabled', mode: 'disabled' } })
  })
})
