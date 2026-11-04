/**
 * The host half's route family, served from a real loopback HTTP server and
 * driven with `fetch`. Nothing about the handlers is stubbed except the gateway
 * and the settings seam, so the fences, the status codes and the payload shapes
 * are the shipped code's own.
 *
 * @module dsh-remote-access/test/routes
 */

import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  API,
  DEFAULT_CONFIG,
  PLUGIN_ID,
  type MeshConfigPatch,
  type MeshConfigResult,
  type MeshKeyPayload,
  type MeshStatus,
} from '../src/protocol.ts'
import { makeRoutes, normalizePatch, withKey, type RouteLogger } from '../src/routes.ts'
import type { MeshGateway } from '../src/mesh/gateway.ts'

const logger: RouteLogger = { debug() {}, info() {}, warn() {}, error() {} }

/** A gateway stand-in that records what the routes ask of it. */
function fakeGateway(): {
  gateway: MeshGateway
  status: MeshStatus
  updates: MeshConfigPatch[]
} {
  const status: MeshStatus = {
    id: PLUGIN_ID,
    version: '0.1.0',
    enabled: true,
    bound: true,
    address: '100.64.0.7',
    bindHost: 'auto',
    port: 3080,
    scheme: 'http',
    urls: ['http://studio.tail.ts.net:3080/', 'http://100.64.0.7:3080/'],
    keyRequired: true,
    hasKey: true,
    upstreamPort: 65202,
    mesh: { kind: 'mesh', interface: 'utun4', address: '100.64.0.7' },
  }
  const updates: MeshConfigPatch[] = []
  const gateway = {
    status: () => status,
    update: async (patch: MeshConfigPatch) => {
      updates.push(patch)
      return { ...DEFAULT_CONFIG, ...patch }
    },
  } as unknown as MeshGateway
  return { gateway, status, updates }
}

const keyState = { value: 'first-key', minted: 0 }

let persistResult: { saved: boolean; saveError?: string } = { saved: true }
const persistCalls: MeshConfigPatch[] = []

const { gateway, updates } = fakeGateway()
const routes = makeRoutes({
  logger,
  gateway,
  key: () => keyState.value,
  regenerate: () => {
    keyState.minted += 1
    keyState.value = `key-${keyState.minted}`
    return keyState.value
  },
  persist: async (patch) => {
    persistCalls.push(patch)
    return persistResult
  },
})

let server: Server
let origin: string

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = routes.find((candidate) => candidate.path === path)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the test server bound no TCP port')
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  updates.length = 0
  persistCalls.length = 0
  persistResult = { saved: true }
})

describe('GET status', () => {
  it('answers with the gateway snapshot', async () => {
    const response = await fetch(`${origin}${API.status}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const payload = (await response.json()) as MeshStatus
    expect(payload.id).toBe(PLUGIN_ID)
    expect(payload.address).toBe('100.64.0.7')
    expect(payload.mesh.kind).toBe('mesh')
  })

  it('rejects a method the route does not own', async () => {
    const response = await fetch(`${origin}${API.status}`, { method: 'POST' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'method-not-allowed' })
  })
})

describe('POST config', () => {
  it('applies and persists a valid patch', async () => {
    const response = await fetch(`${origin}${API.config}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, port: 3081, bindHost: 'all', requireKey: false }),
    })
    expect(response.status).toBe(200)
    const result = (await response.json()) as MeshConfigResult
    expect(result.saved).toBe(true)
    expect(updates).toEqual([{ enabled: true, port: 3081, bindHost: 'all', requireKey: false }])
    expect(persistCalls).toHaveLength(1)
  })

  it('reports a settings write that did not land', async () => {
    persistResult = { saved: false, saveError: 'read-only profile' }
    const response = await fetch(`${origin}${API.config}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    const result = (await response.json()) as MeshConfigResult
    expect(result.saved).toBe(false)
    expect(result.saveError).toBe('read-only profile')
  })

  it('refuses a port outside the range', async () => {
    const response = await fetch(`${origin}${API.config}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 70000 }),
    })
    expect(response.status).toBe(400)
    expect((await response.json()) as { error: string }).toMatchObject({
      error: 'port-must-be-an-integer-1-65535',
    })
    expect(updates).toEqual([])
  })

  it('refuses a bind host that is neither auto, all, nor an IPv4 literal', async () => {
    const response = await fetch(`${origin}${API.config}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bindHost: 'example.com' }),
    })
    expect(response.status).toBe(400)
    expect((await response.json()) as { error: string }).toMatchObject({
      error: 'bind-host-must-be-auto-all-or-an-ipv4-literal',
    })
  })

  it('refuses malformed JSON without touching the gateway', async () => {
    const response = await fetch(`${origin}${API.config}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(response.status).toBe(400)
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid-json' })
    expect(updates).toEqual([])
  })
})

describe('the access key', () => {
  it('returns the key with links that already carry it', async () => {
    const response = await fetch(`${origin}${API.key}`)
    expect(response.status).toBe(200)
    const payload = (await response.json()) as MeshKeyPayload
    expect(payload.key).toBe('first-key')
    expect(payload.urls[0]).toBe('http://studio.tail.ts.net:3080/?key=first-key')
  })

  it('returns plain links and no key when the key is not required', async () => {
    const status = gateway.status() as MeshStatus
    status.keyRequired = false
    try {
      const plain = (await (await fetch(`${origin}${API.key}`)).json()) as MeshKeyPayload
      expect(plain.key).toBe('')
      expect(plain.urls).toEqual(status.urls)
      const replaced = (await (await fetch(`${origin}${API.regenerate}`, { method: 'POST' })).json()) as MeshKeyPayload
      expect(replaced.key).toBe('')
      expect(replaced.urls).toEqual(status.urls)
      expect(keyState.minted).toBe(0)
    } finally {
      status.keyRequired = true
    }
  })

  it('replaces the key and re-encodes the links', async () => {
    const response = await fetch(`${origin}${API.regenerate}`, { method: 'POST' })
    expect(response.status).toBe(200)
    const payload = (await response.json()) as MeshKeyPayload
    expect(payload.key).toBe('key-1')
    expect(payload.urls[1]).toBe('http://100.64.0.7:3080/?key=key-1')
  })
})

describe('normalizePatch', () => {
  it('accepts an empty patch', () => {
    expect(normalizePatch({})).toEqual({ ok: true, patch: {} })
  })

  it('rejects a non-object', () => {
    expect(normalizePatch('nope')).toEqual({ ok: false, error: 'invalid-patch' })
  })

  it('trims a typed address', () => {
    expect(normalizePatch({ bindHost: '  100.64.1.9 ' })).toEqual({
      ok: true,
      patch: { bindHost: '100.64.1.9' },
    })
  })

  it('rejects a non-boolean switch', () => {
    expect(normalizePatch({ requireKey: 'yes' })).toEqual({
      ok: false,
      error: 'require-key-must-be-boolean',
    })
  })
})

describe('withKey', () => {
  it('encodes a key that needs escaping', () => {
    expect(withKey(['http://100.64.0.1:3080/'], 'a+b/c=')).toEqual([
      'http://100.64.0.1:3080/?key=a%2Bb%2Fc%3D',
    ])
  })
})

describe('the loopback fence', () => {
  it('refuses a route call that did not arrive over loopback', async () => {
    const route = routes.find((candidate) => candidate.path === API.status)
    if (route === undefined) throw new Error('status route missing')
    const written: { status?: number; headers?: Record<string, unknown>; body?: string } = {}
    const res = {
      setHeader() {},
      writeHead(status: number, headers: Record<string, unknown>) {
        written.status = status
        written.headers = headers
      },
      end(body?: string) {
        written.body = body
      },
    }
    const req = { socket: { remoteAddress: '192.168.1.50' }, method: 'GET', url: API.status }
    await route.handler(req as never, res as never)
    expect(written.status).toBe(403)
    expect(written.body).toContain('forbidden')
  })
})

describe('registered path family', () => {
  it('keeps every route under the plugin namespace', () => {
    for (const route of routes) {
      expect(route.kind).toBe('exact')
      expect(route.path.startsWith(`/api/${PLUGIN_ID}/`)).toBe(true)
    }
    expect(routes.map((route) => route.path)).toEqual(Object.values(API))
  })
})