/**
 * Key storage: minted once, reused, written owner-only, and replaceable.
 *
 * @module dsh-remote-access/test/secret
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureKey, readKey, regenerateKey, secretPath } from '../src/mesh/secret.ts'

let home: string
let previous: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-remote-access-'))
  previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
})

afterEach(() => {
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
  rmSync(home, { recursive: true, force: true })
})

describe('the access key', () => {
  it('mints one on first use and keeps it', () => {
    expect(readKey()).toBe('')
    const first = ensureKey(() => 'fixed-key')
    expect(first).toBe('fixed-key')
    expect(readKey()).toBe('fixed-key')
    // A second ensure must not mint over the existing file.
    expect(ensureKey(() => 'different')).toBe('fixed-key')
  })

  it('writes it owner-only, inside the plugin directory', () => {
    ensureKey(() => 'fixed-key')
    const path = secretPath()
    expect(path).toBe(join(home, 'remote-access', 'key'))
    expect(readFileSync(path, 'utf8').trim()).toBe('fixed-key')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('replaces it on demand', () => {
    ensureKey(() => 'fixed-key')
    expect(regenerateKey(() => 'new-key')).toBe('new-key')
    expect(readKey()).toBe('new-key')
  })

  it('mints URL-safe material by default', () => {
    const key = ensureKey()
    expect(key.length).toBeGreaterThanOrEqual(40)
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/u)
  })
})