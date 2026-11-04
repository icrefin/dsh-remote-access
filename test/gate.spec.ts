/**
 * The credential: signing, verification, the unlock page, and the failure
 * budget that keeps a leaked address from being guessed at.
 *
 * @module dsh-remote-access/test/gate
 */

import { describe, expect, it } from 'vitest'
import {
  FAILURE_LIMIT,
  FailureLimiter,
  clearedCookie,
  escapeHtml,
  isSessionValid,
  keyMatches,
  readCookie,
  safeNext,
  sessionCookie,
  sessionValue,
  unlockPage,
} from '../src/mesh/gate.ts'
import { MESH_COOKIE } from '../src/protocol.ts'

const KEY = 'test-key'

describe('session signing', () => {
  it('is deterministic for one key and differs across keys', () => {
    expect(sessionValue(KEY)).toBe(sessionValue(KEY))
    expect(sessionValue(KEY)).not.toBe(sessionValue('other'))
  })

  it('accepts the cookie it issued', () => {
    const value = `${MESH_COOKIE}=${sessionValue(KEY)}`
    expect(isSessionValid(value, KEY)).toBe(true)
  })

  it('finds its cookie among others', () => {
    const header = `theme=dark; ${MESH_COOKIE}=${sessionValue(KEY)}; other=1`
    expect(isSessionValid(header, KEY)).toBe(true)
    expect(readCookie(header)).toBe(sessionValue(KEY))
  })

  it('rejects a missing, empty, tampered, or wrong-key cookie', () => {
    expect(isSessionValid(undefined, KEY)).toBe(false)
    expect(isSessionValid(`${MESH_COOKIE}=`, KEY)).toBe(false)
    expect(isSessionValid(`${MESH_COOKIE}=nope`, KEY)).toBe(false)
    expect(isSessionValid(`${MESH_COOKIE}=${sessionValue('other')}`, KEY)).toBe(false)
    expect(isSessionValid(`${MESH_COOKIE}=${sessionValue(KEY)}`, '')).toBe(false)
  })

  it('issues a host-only, strict, HttpOnly cookie', () => {
    const header = sessionCookie(KEY)
    expect(header).toContain(`${MESH_COOKIE}=`)
    expect(header).toContain('Path=/')
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Strict')
    expect(header).toContain('Max-Age=2592000')
    expect(header).not.toContain('Domain=')
    // The mesh leg is plain HTTP; a Secure flag would make the browser drop it.
    expect(header).not.toContain('Secure')
  })

  it('can clear the cookie', () => {
    expect(clearedCookie()).toContain('Max-Age=0')
  })
})

describe('key comparison', () => {
  it('matches only the exact key', () => {
    expect(keyMatches(KEY, KEY)).toBe(true)
    expect(keyMatches('test-ke', KEY)).toBe(false)
    expect(keyMatches('test-key ', KEY)).toBe(false)
    expect(keyMatches('', '')).toBe(false)
  })
})

describe('safeNext', () => {
  it('keeps same-origin paths', () => {
    expect(safeNext('/')).toBe('/')
    expect(safeNext('/settings?tab=plugins')).toBe('/settings?tab=plugins')
  })

  it('rejects anything that could leave the host', () => {
    expect(safeNext('//evil.example/')).toBe('/')
    expect(safeNext('https://evil.example/')).toBe('/')
    expect(safeNext('/\\evil')).toBe('/')
    expect(safeNext(undefined)).toBe('/')
  })
})

describe('unlock page', () => {
  it('escapes the authority it echoes', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;')
    const html = unlockPage({ authority: '100.64.0.1:3080" onload="x', next: '/' })
    expect(html).not.toContain('onload="x')
    expect(html).toContain('&quot; onload=&quot;x')
  })

  it('posts the key to the gateway path, not the harness', () => {
    const html = unlockPage({ authority: '100.64.0.1:3080', next: '/?a=1' })
    expect(html).toContain('action="/__remote/unlock"')
    expect(html).toContain('type="password"')
    expect(html).toContain('name="next" value="/?a=1"')
  })

  it('shows a failure without markup', () => {
    const html = unlockPage({ authority: 'h', next: '/', error: 'Wrong <b>key</b>' })
    expect(html).toContain('Wrong &lt;b&gt;key&lt;/b&gt;')
  })
})

describe('FailureLimiter', () => {
  let clock = 0
  const limiter = new FailureLimiter(FAILURE_LIMIT, 1_000, () => clock)

  it('blocks a client that spends its budget, and only that client', () => {
    clock = 0
    for (let attempt = 0; attempt < FAILURE_LIMIT; attempt += 1) {
      expect(limiter.isBlocked('a')).toBe(false)
      limiter.recordFailure('a')
    }
    expect(limiter.isBlocked('a')).toBe(true)
    expect(limiter.isBlocked('b')).toBe(false)
  })

  it('forgets failures once the window passes', () => {
    clock = 1_001
    expect(limiter.isBlocked('a')).toBe(false)
    expect(limiter.isBlocked('b')).toBe(false)
  })

  it('clears a client after a success', () => {
    clock = 2_000
    limiter.recordFailure('c')
    limiter.clear('c')
    expect(limiter.isBlocked('c')).toBe(false)
  })
})