/**
 * The browser half's view of the route family, and the constants both halves
 * must agree on.
 *
 * The regression this pins: an origin-absolute `/api/...` path is correct only
 * while the client is served at the origin root. `dsh-remote-control` mounts
 * the same client at `/s/<sessionId>/`, and an absolute request escapes that
 * mount — the prefix's host answers for `/api/...` with a `200 text/html` page,
 * which `response.json()` reports as `Unexpected token '<'`. Resolving the
 * plugin's own request paths against the document keeps them inside whatever
 * prefix the client is served from.
 *
 * @module dsh-remote-access/test/protocol
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { DEFAULT_CONFIG, API, CLIENT_API, PLUGIN_ID, VERSION, clientPath } from '../src/protocol.ts'

/** Where the desktop app and a root-mounted `dsh web` serve the client. */
const AT_ROOT = 'http://127.0.0.1:50603/'

/** Where `dsh-remote-control` serves the same client to a paired browser. */
const UNDER_TUNNEL = 'https://relay.example/s/ab12/'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string
  version: string
}

describe('CLIENT_API', () => {
  it('never begins with a slash, so it resolves against the document', () => {
    for (const path of Object.values(CLIENT_API)) {
      expect(path.startsWith('/')).toBe(false)
    }
  })

  it('reaches the host route when the client is at the origin root', () => {
    for (const [name, path] of Object.entries(CLIENT_API)) {
      const route = API[name as keyof typeof API]
      expect(new URL(path, AT_ROOT).pathname).toBe(route)
    }
  })

  it('stays inside a mounted prefix, which is what the tunnel needs', () => {
    expect(new URL(CLIENT_API.status, UNDER_TUNNEL).pathname).toBe(`/s/ab12${API.status}`)
  })

  it('derives every client route from its host route', () => {
    for (const [name, path] of Object.entries(CLIENT_API)) {
      expect(path).toBe(clientPath(API[name as keyof typeof API]))
    }
  })
})

describe('the absolute path it replaced', () => {
  it('escapes the mount, which is why the panel would see HTML instead of JSON', () => {
    expect(new URL(API.status, UNDER_TUNNEL).pathname).toBe(API.status)
  })
})

describe('identity', () => {
  it('uses the package name as the loader row id', () => {
    expect(PLUGIN_ID).toBe(manifest.name)
  })

  it('reports the version the artifact was built from', () => {
    expect(VERSION).toBe(manifest.version)
  })

  it('starts idle and key-free, so installing changes nothing until a person enables it', () => {
    expect(DEFAULT_CONFIG.enabled).toBe(false)
    // The private mesh is the trust boundary; the key is opt-in hardening.
    expect(DEFAULT_CONFIG.requireKey).toBe(false)
    expect(DEFAULT_CONFIG.port).toBe(3080)
  })
})