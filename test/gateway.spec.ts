/**
 * The gateway, end to end, with no stubs between the sockets.
 *
 * A real HTTP server stands in for the harness: it mints a browser session from
 * a launch token, refuses an authenticated request without the cookie, refuses
 * a request whose Host is not loopback, and refuses one that carries an Origin.
 * The gateway is then driven with `fetch` and a raw WebSocket handshake, which
 * is the only way to prove the two load-bearing rewrites actually happen.
 *
 * @module dsh-remote-access/test/gateway
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MESH_COOKIE } from '../src/protocol.ts'
import { sessionValue } from '../src/mesh/gate.ts'
import { MeshGateway, withoutKey, type GatewayLogger } from '../src/mesh/gateway.ts'

const KEY = 'mesh-test-key'
const logger: GatewayLogger = { debug() {}, info() {}, warn() {} }

/** One upstream request the fake harness saw. */
interface Seen {
  method: string
  url: string
  host: string | undefined
  origin: string | undefined
  cookie: string | undefined
  marker: string | undefined
}

const seen: Seen[] = []
const upgraded = new Set<Duplex>()
let upstream: Server
let upstreamPort = 0
let harnessCookie = 'dsh_session=first'
let minted = 0
let expireNext = false

/** Collect a request body as text. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

/** Answer JSON. */
function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** Bind the fake harness on a free loopback port. */
async function startUpstream(): Promise<void> {
  upstream = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      host: req.headers.host,
      origin: req.headers.origin,
      cookie: req.headers.cookie,
      marker: req.headers['x-dsh-remote-access'] as string | undefined,
    })
    // The launch-token exchange: no cookie, and the token in the query.
    if (url.pathname === '/' && url.searchParams.has('token')) {
      minted += 1
      harnessCookie = minted === 1 ? 'dsh_session=first' : 'dsh_session=second'
      res.writeHead(303, { location: '/', 'set-cookie': `${harnessCookie}; Path=/; HttpOnly` })
      res.end()
      return
    }
    if (req.headers.host !== `127.0.0.1:${upstreamPort}`) {
      json(res, 421, { error: 'bad-host', host: req.headers.host })
      return
    }
    if (req.headers.origin !== undefined) {
      json(res, 403, { error: 'bad-origin' })
      return
    }
    if (req.headers.cookie !== harnessCookie) {
      json(res, 401, { error: 'unauthenticated' })
      return
    }
    if (expireNext) {
      expireNext = false
      json(res, 401, { error: 'expired' })
      return
    }
    if (url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'harness_only=1; Path=/',
      })
      res.end('<html><head><base href="./"></head><body>harness shell</body></html>')
      return
    }
    // Plugin bundles use the harness's `??` path convention, which is not a
    // query string even though it contains a `?`.
    if ((req.url ?? '').startsWith('/plugins/')) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end('window.__ModuleLoader__.load({ id: "x", factory: () => ({}) })')
      return
    }
    if (url.pathname === '/api/ping') {
      json(res, 200, { host: req.headers.host, sawKey: url.searchParams.has('key'), query: url.search })
      return
    }
    if (url.pathname === '/api/echo') {
      void readBody(req).then((body) => json(res, 200, { body, method: req.method }))
      return
    }
    json(res, 404, { error: 'not-found' })
  })
  upstream.on('upgrade', (req, socket) => {
    upgraded.add(socket)
    socket.on('close', () => upgraded.delete(socket))
    if (req.headers.cookie !== harnessCookie) {
      socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n')
      return
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
    socket.on('data', (chunk: Buffer) => socket.write(`echo:${chunk.toString('utf8')}`))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamPort = (upstream.address() as AddressInfo).port
}

/** Find one free loopback port. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

let gateway: MeshGateway
let gatewayPort = 0

/** The gateway origin under test. */
function origin(path = '/'): string {
  return `http://127.0.0.1:${gatewayPort}${path}`
}

/** Read a `Set-Cookie` value out of a response. */
function cookieOf(response: Response): string | undefined {
  const raw = response.headers.get('set-cookie')
  if (raw === null) return undefined
  return raw.split(';')[0]?.trim()
}

beforeAll(async () => {
  await startUpstream()
  gatewayPort = await freePort()
  gateway = new MeshGateway({
    logger,
    upstream: () => ({ host: '127.0.0.1', port: upstreamPort }),
    launchUrl: () => `http://127.0.0.1:${upstreamPort}/?token=process-token`,
    key: () => KEY,
    initial: { enabled: false, port: gatewayPort, bindHost: '127.0.0.1', requireKey: true },
    candidates: () => [{ address: '127.0.0.1', iface: 'lo0', kind: 'lan', score: 1 }],
    localAddresses: () => ['127.0.0.1'],
    version: '0.1.0',
  })
})

afterAll(async () => {
  await gateway.dispose()
  // Upgraded sockets are not covered by `closeAllConnections`, and a lingering
  // one would keep `close()` waiting forever.
  for (const socket of upgraded) socket.destroy()
  upstream.closeAllConnections()
  await Promise.race([
    new Promise<void>((resolve) => upstream.close(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ])
})

describe('lifecycle', () => {
  it('binds nothing while idle', () => {
    const status = gateway.status()
    expect(status.enabled).toBe(false)
    expect(status.bound).toBe(false)
  })

  it('binds the configured address on enable', async () => {
    await gateway.update({ enabled: true, port: gatewayPort })
    const status = gateway.status()
    expect(status.bound).toBe(true)
    expect(status.address).toBe('127.0.0.1')
    expect(status.port).toBe(gatewayPort)
    expect(status.urls).toEqual([`http://127.0.0.1:${gatewayPort}/`])
    expect(status.since).toBeDefined()
  })
})

describe('the key gate', () => {
  it('answers a page request without a cookie with the unlock page', async () => {
    const response = await fetch(origin('/'), { redirect: 'manual' })
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toContain('text/html')
    const body = await response.text()
    expect(body).toContain('Remote Access')
    expect(body).toContain('action="/__remote/unlock"')
    // The harness was never dialled for a challenged request.
    expect(seen.some((entry) => entry.url === '/')).toBe(false)
  })

  it('answers an API request without a cookie with JSON', async () => {
    const response = await fetch(origin('/api/ping'))
    expect(response.status).toBe(401)
    expect(((await response.json()) as { error: string }).error).toBe('mesh-auth-required')
  })

  it('rejects a wrong key in the unlock form', async () => {
    const response = await fetch(origin('/__remote/unlock'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: 'wrong', next: '/' }).toString(),
      redirect: 'manual',
    })
    expect(response.status).toBe(401)
    expect(await response.text()).toContain('not right')
  })

  it('issues its own cookie for the right key', async () => {
    const response = await fetch(origin('/__remote/unlock'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: KEY, next: '/settings' }).toString(),
      redirect: 'manual',
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/settings')
    expect(cookieOf(response)).toBe(`${MESH_COOKIE}=${sessionValue(KEY)}`)
  })

  it('accepts a key in the query and redirects it away', async () => {
    const response = await fetch(origin(`/?key=${encodeURIComponent(KEY)}&tab=x`), { redirect: 'manual' })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/?tab=x')
    expect(cookieOf(response)).toBe(`${MESH_COOKIE}=${sessionValue(KEY)}`)
  })

  it('never leaks the harness cookie to the browser', async () => {
    const cookie = `${MESH_COOKIE}=${sessionValue(KEY)}`
    const response = await fetch(origin('/'), { headers: { cookie }, redirect: 'manual' })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.text()).toContain('harness shell')
  })
})

describe('withoutKey', () => {
  it('removes the key without re-encoding anything else', () => {
    expect(withoutKey('/api/ping?key=K&x=1')).toBe('/api/ping?x=1')
    expect(withoutKey('/api/ping?x=1&key=K')).toBe('/api/ping?x=1')
    expect(withoutKey('/?key=K')).toBe('/')
    expect(withoutKey('/api/ping')).toBe('/api/ping')
    expect(withoutKey('/api/ping?key=K&x=a%20b')).toBe('/api/ping?x=a%20b')
  })

  it('leaves the harness bundle convention untouched', () => {
    const bundle = '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=abc123'
    expect(withoutKey(bundle)).toBe(bundle)
    expect(withoutKey(`${bundle}&key=K`)).toBe(bundle)
  })
})

describe('the loopback replay', () => {
  const cookie = `${MESH_COOKIE}=${sessionValue(KEY)}`

  it('rewrites Host, drops Origin, and attaches the minted harness cookie', async () => {
    const response = await fetch(origin('/api/ping'), {
      headers: { cookie, origin: `http://127.0.0.1:${gatewayPort}`, referer: 'http://evil.example/' },
    })
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { host: string; sawKey: boolean }
    expect(payload.host).toBe(`127.0.0.1:${upstreamPort}`)
    const last = seen[seen.length - 1]
    expect(last?.origin).toBeUndefined()
    expect(last?.cookie).toBe(harnessCookie)
    expect(last?.marker).toBe('1')
  })

  it('delivers a plugin bundle target byte for byte', async () => {
    const target = '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=abc123'
    const response = await fetch(origin(target), { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/javascript')
    expect(seen[seen.length - 1]?.url).toBe(target)
  })

  it('strips the access key before the harness sees the URL', async () => {
    const response = await fetch(origin(`/api/ping?key=${encodeURIComponent(KEY)}&x=1`), { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(seen[seen.length - 1]?.url).toBe('/api/ping?x=1')
  })

  it('carries a request body through unchanged', async () => {
    const response = await fetch(origin('/api/echo'), {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain' },
      body: 'hello mesh',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ body: 'hello mesh', method: 'POST' })
  })

  it('mints a fresh harness session when the cached one is refused', async () => {
    expireNext = true
    const before = minted
    const response = await fetch(origin('/api/ping'), { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(minted).toBe(before + 1)
  })

  it('tunnels a WebSocket upgrade', async () => {
    const result = await upgrade(origin('/api/remote.mux'), cookie)
    expect(result.status).toBe(101)
    expect(result.reply).toContain('echo:ping')
  })

  it('refuses an upgrade without a cookie', async () => {
    const result = await upgrade(origin('/api/remote.mux'), undefined)
    expect(result.status).toBe(401)
  })
})

describe('key policy and teardown', () => {
  it('serves without a cookie when the key is switched off', async () => {
    await gateway.update({ requireKey: false })
    const response = await fetch(origin('/'))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('harness shell')
  })

  it('closes the socket when disabled', async () => {
    await gateway.update({ enabled: false })
    const status = gateway.status()
    expect(status.bound).toBe(false)
    await expect(fetch(origin('/'))).rejects.toThrow()
  })
})

/**
 * Speak the WebSocket handshake over a raw socket and read the answer.
 *
 * `fetch` cannot express an upgrade, and a client library would hide the
 * headers this test is about.
 */
function upgrade(url: string, cookie: string | undefined): Promise<{ status: number; reply: string }> {
  const parsed = new URL(url)
  return new Promise((resolve) => {
    const socket = connect(Number(parsed.port), parsed.hostname)
    let buffer = ''
    let status = 0
    let sent = false
    socket.setTimeout(5_000)
    socket.on('connect', () => {
      const lines = [
        `GET ${parsed.pathname} HTTP/1.1`,
        `host: ${parsed.host}`,
        'connection: Upgrade',
        'upgrade: websocket',
        'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version: 13',
        ...(cookie === undefined ? [] : [`cookie: ${cookie}`]),
        '',
        '',
      ]
      socket.write(lines.join('\r\n'))
    })
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      if (status === 0) {
        const head = buffer.indexOf('\r\n\r\n')
        if (head < 0) return
        status = Number(buffer.slice(9, 12))
        if (status !== 101) {
          socket.destroy()
          resolve({ status, reply: buffer })
          return
        }
      }
      if (!sent && buffer.includes('\r\n\r\n')) {
        sent = true
        socket.write('ping')
      }
      if (buffer.includes('echo:ping')) {
        socket.destroy()
        resolve({ status, reply: buffer })
      }
    })
    socket.on('timeout', () => {
      socket.destroy()
      resolve({ status, reply: buffer })
    })
    socket.on('error', () => resolve({ status, reply: buffer }))
    socket.on('close', () => resolve({ status, reply: buffer }))
  })
}