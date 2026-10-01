// Buyer credential: a 256-bit random recovery code, shown once, sent only in an Authorization header.
// The store keeps SHA-256 of it. With 256 bits of entropy a fast hash is sufficient (same reasoning as
// API tokens); a slow password hash would add nothing but latency.
import { createHash, randomBytes, randomUUID } from 'node:crypto'

const PREFIX = 'hhr_'
const CODE = /^hhr_[A-Za-z0-9_-]{43}$/

export function newRecoveryCode(): string {
  return PREFIX + randomBytes(32).toString('base64url')
}

export function isRecoveryCode(value: string): boolean {
  return CODE.test(value)
}

export function hashRecoveryCode(code: string): string {
  if (!isRecoveryCode(code)) throw new RangeError('malformed recovery code')
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

// `Authorization: Bearer hhr_...` -> code, or undefined. Never read from the URL or the body.
export function bearerCode(request: Request): string | undefined {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer (hhr_[A-Za-z0-9_-]{43})$/.exec(header)
  return match?.[1]
}

export function newId(): string {
  return randomUUID()
}
