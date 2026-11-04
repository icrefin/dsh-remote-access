/**
 * The listener that puts this harness on the mesh.
 *
 * The desktop shell launches the harness with `--host 127.0.0.1 --port 0`, and
 * the web server refuses a wildcard bind by design, so there is no configuration
 * that makes the harness itself listen on the tailnet. This gateway is the honest
 * alternative: it binds one concrete mesh address, authenticates the browser
 * with a key of its own, and replays each request against the harness's loopback
 * listener. The remote browser then runs the real client — sessions, prompts,
 * terminal, streaming — because it receives the bytes the local window receives.
 *
 * Three details are load-bearing:
 *
 * - **Host and Origin are rewritten.** Upstream is dialled as
 *   `127.0.0.1:<port>`, which is what the harness fence accepts; the browser's
 *   own `Origin`, `Referer` and `Sec-Fetch-*` markers name the mesh authority and
 *   would be refused, so they are dropped.
 * - **The harness cookie is minted here, never forwarded.** The launch token
 *   exchange happens server-side through `ctx.connection.authenticatedUrl`, and
 *   `Set-Cookie` from upstream is stripped. The remote browser only ever holds
 *   this gateway's own cookie, so revoking the key revokes every device.
 * - **Only one concrete address is bound.** `0.0.0.0` is available as an
 *   explicit choice, but it is never the default: binding the Wi-Fi address
 *   would expose an agent with a shell to whatever network the laptop joins.
 *
 * @module dsh-remote-access/mesh/gateway
 */

import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import {
  DEFAULT_CONFIG,
  GATEWAY,
  type MeshConfig,
  type MeshConfigPatch,
  type MeshFacts,
  type MeshStatus,
} from '../protocol.ts'
import {
  isCgnatIPv4,
  listCandidates,
  localIPv4Addresses,
  pickCandidate,
  type MeshCandidate,
  type TailscaleProbe,
  type TailscaleState,
} from './detect.ts'
import {
  FailureLimiter,
  isSessionValid,
  keyMatches,
  safeNext,
  sessionCookie,
  unlockPage,
} from './gate.ts'

/** Minimal logging seam, matching the harness logger shape. */
export interface GatewayLogger {
  /** Verbose diagnostics, suppressed in normal runs. */
  debug(message: string): void
  /** Lifecycle transitions worth recording. */
  info(message: string): void
  /** Recoverable problems. */
  warn(message: string): void
}

/** The loopback endpoint this gateway dials. */
export interface Upstream {
  /** Loopback literal. */
  host: string
  /** Bound port of the harness web server, or 0 before it binds. */
  port: number
}

/** Options for {@link MeshGateway}. */
export interface MeshGatewayOptions {
  /** Destination for lifecycle logs. */
  logger: GatewayLogger
  /** Loopback endpoint of the harness web server; read per request. */
  upstream: () => Upstream
  /** Clean loopback URL carrying the process launch token. */
  launchUrl: () => string | undefined
  /** The current access key; mints one when absent. */
  key: () => string
  /** Whether a key exists, without minting one. Defaults to minting on read. */
  hasKey?: () => boolean
  /** Settings read from the Loader row. */
  initial?: Partial<MeshConfig>
  /** Interface candidates; injectable so tests never touch the real network. */
  candidates?: () => MeshCandidate[]
  /** Every local IPv4 literal, for validating a hand-typed bind address. */
  localAddresses?: () => string[]
  /** Tailscale facts, refreshed in the background. */
  tailscale?: TailscaleProbe
  /** Delay before retrying a bind that could not succeed. */
  retryMs?: number
  /** Package version, reported by `status()`. */
  version?: string
  /** Clock; injectable. */
  now?: () => number
}

/** Request headers that must not cross the loopback hop. */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'origin',
  'referer',
  'cookie',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
])

/** Upgrade handshake headers that the hop must keep. */
const UPGRADE_SKIP: ReadonlySet<string> = new Set([
  'host',
  'origin',
  'referer',
  'cookie',
  'proxy-connection',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
])

/** Response headers that describe the hop rather than the payload. */
const RESPONSE_DROP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'trailer',
  'upgrade',
  // The harness cookie is bound to loopback; the browser must never see it.
  'set-cookie',
])

/** Marks a request that this gateway replayed, for host-side diagnostics. */
export const PROXY_MARKER = 'x-dsh-remote-access'

/** Largest unlock form body accepted, in bytes. */
const MAX_UNLOCK_BODY = 4 * 1024

/**
 * Pick a stable, low-entropy message out of a thrown value.
 * @param error - thrown value.
 * @returns a one-line description.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Strip the access key out of a request target, byte for byte.
 *
 * This must not re-serialize the target through `URL`/`URLSearchParams`. The
 * harness addresses plugin bundles as `plugins/??<pkg>/client.js&rev=<hash>`:
 * a path convention whose first `?` makes everything after it look like a query
 * string. Re-encoding that query turns `??` into `?%3F%40…`, the bundle route
 * answers 404, and the browser reports `HTML did not preload
 * @deepseek-ai/dsh-client-modules/client.js` because the bootstrap module never
 * registered. Removing the key textually keeps every other byte untouched.
 *
 * @param target - the raw request target, as received.
 * @returns the same target without a `key` parameter.
 */
export function withoutKey(target: string): string {
  const queryStart = target.indexOf('?')
  if (queryStart < 0) return target
  const head = target.slice(0, queryStart)
  const pieces = target.slice(queryStart + 1).split('&')
  const kept = pieces.filter((piece) => !/^key=/u.test(piece))
  if (kept.length === pieces.length) return target
  return kept.length === 0 ? head : `${head}?${kept.join('&')}`
}

/**
 * Whether an unauthenticated request expects JSON rather than a page.
 * @param req - the request.
 * @param url - its parsed URL.
 * @returns true for an API caller.
 */
function wantsJson(req: IncomingMessage, url: URL): boolean {
  if (url.pathname.startsWith('/api/')) return true
  return (req.headers.accept ?? '').includes('application/json')
}

/**
 * Resolve one bind plan.
 *
 * Split from the listener so the addressing rules are testable without sockets.
 */
type BindPlan =
  | { kind: 'ok'; host: string; urls: string[]; mesh: MeshFacts }
  | { kind: 'error'; message: string; mesh: MeshFacts }

/**
 * The mesh gateway: one listener, its settings, and its lifecycle.
 */
export class MeshGateway {
  private readonly options: MeshGatewayOptions
  private readonly logger: GatewayLogger
  private readonly limiter = new FailureLimiter()
  private readonly sockets = new Set<Duplex>()
  private readonly upstreamSockets = new Set<Duplex>()

  private config: MeshConfig
  private server: Server | undefined
  private bindKey: string | undefined
  private bound: { address: string; port: number } | undefined
  private mesh: MeshFacts = { kind: 'none' }
  private urls: string[] = []
  private error: string | undefined
  private since: string | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retryMs: number
  private queue: Promise<void> = Promise.resolve()
  private disposed = false

  private cachedCookie: string | undefined
  private minting: Promise<string | undefined> | undefined

  /**
   * @param options - destinations, credentials and injectable facts.
   */
  constructor(options: MeshGatewayOptions) {
    this.options = options
    this.logger = options.logger
    this.retryMs = options.retryMs ?? 10_000
    this.config = { ...DEFAULT_CONFIG, ...options.initial }
  }

  /** The settings currently in force. */
  get settings(): MeshConfig {
    return { ...this.config }
  }

  /**
   * Change one or more settings and reconcile the listener.
   * @param patch - fields to replace.
   * @returns the settings in force after the change.
   */
  async update(patch: MeshConfigPatch): Promise<MeshConfig> {
    const next: MeshConfig = { ...this.config }
    if (patch.enabled !== undefined) next.enabled = patch.enabled
    if (patch.port !== undefined) next.port = patch.port
    if (patch.bindHost !== undefined) next.bindHost = patch.bindHost
    if (patch.requireKey !== undefined) next.requireKey = patch.requireKey
    this.config = next
    await this.reconcile()
    return this.settings
  }

  /** Everything the panel renders. */
  status(): MeshStatus {
    const bound = this.bound
    const upstream = this.options.upstream()
    return {
      id: 'dsh-remote-access',
      version: this.options.version ?? '',
      enabled: this.config.enabled,
      bound: bound !== undefined,
      address: bound?.address ?? this.plannedHost(),
      bindHost: this.config.bindHost,
      port: bound?.port ?? this.config.port,
      scheme: 'http',
      urls: this.urls,
      keyRequired: this.config.requireKey,
      hasKey: (this.options.hasKey ?? (() => this.options.key().length > 0))(),
      upstreamPort: upstream.port,
      mesh: this.mesh,
      ...(this.error === undefined ? {} : { error: this.error }),
      ...(this.since === undefined ? {} : { since: this.since }),
    }
  }

  /**
   * Apply the settings to the socket: bind, rebind, or close.
   * @returns resolves when the listener has settled.
   */
  reconcile(): Promise<void> {
    this.queue = this.queue.then(
      () => this.reconcileNow(),
      () => this.reconcileNow(),
    )
    return this.queue
  }

  /** Stop listening and release every socket. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.clearRetry()
    await this.shutdownListener()
  }

  /** Drop the minted harness cookie, so the next request exchanges the token again. */
  invalidateCookie(): void {
    this.cachedCookie = undefined
  }

  /** The planned bind host, for status before a socket exists. */
  private plannedHost(): string {
    if (this.config.bindHost === 'all') return '0.0.0.0'
    if (this.config.bindHost !== 'auto') return this.config.bindHost
    return this.mesh.address ?? ''
  }

  /** Run one reconcile pass. */
  private async reconcileNow(): Promise<void> {
    if (this.disposed) return
    if (!this.config.enabled) {
      await this.shutdownListener()
      this.error = undefined
      this.mesh = { kind: 'none' }
      this.urls = []
      this.since = undefined
      return
    }
    await this.refreshTailscale()
    const plan = this.resolveTarget()
    this.mesh = plan.mesh
    this.urls = plan.kind === 'ok' ? plan.urls : []
    if (plan.kind === 'error') {
      await this.shutdownListener()
      this.error = plan.message
      this.scheduleRetry()
      return
    }
    const key = `${plan.host}:${this.config.port}`
    if (this.server !== undefined && this.bindKey === key) return
    await this.shutdownListener()
    await this.bind(plan.host, this.config.port)
  }

  /** Refresh Tailscale facts without blocking the bind on a missing CLI. */
  private async refreshTailscale(): Promise<void> {
    const probe = this.options.tailscale
    if (probe === undefined) return
    await probe.read()
  }

  /** A Tailscale state for display, when one was read. */
  private tailscale(): TailscaleState | undefined {
    return this.options.tailscale?.current
  }

  /** Decide which address to bind and which URLs to advertise. */
  private resolveTarget(): BindPlan {
    const candidates = this.options.candidates?.() ?? listCandidates()
    const tailscale = this.tailscale()
    const base: MeshFacts = { kind: 'none' }
    const decorate = (facts: MeshFacts): MeshFacts => ({
      ...facts,
      ...(tailscale?.nodeName === undefined ? {} : { nodeName: tailscale.nodeName }),
      ...(tailscale?.dnsName === undefined ? {} : { dnsName: tailscale.dnsName }),
      ...(tailscale?.tailnet === undefined ? {} : { tailnet: tailscale.tailnet }),
      ...(tailscale?.online === undefined ? {} : { online: tailscale.online }),
    })

    if (this.config.bindHost === 'all') {
      const addresses = [...new Set(candidates.map((candidate) => candidate.address))]
      return {
        kind: 'ok',
        host: '0.0.0.0',
        urls: this.advertise(addresses, tailscale),
        mesh: decorate({ kind: 'all', address: '0.0.0.0' }),
      }
    }

    if (this.config.bindHost === 'auto') {
      const chosen = pickCandidate(candidates, tailscale)
      if (chosen === undefined) {
        return {
          kind: 'error',
          message: 'no private mesh interface is available — start Tailscale, or set a bind address explicitly',
          mesh: base,
        }
      }
      return {
        kind: 'ok',
        host: chosen.address,
        urls: this.advertise([chosen.address], tailscale),
        mesh: decorate({ kind: chosen.kind, interface: chosen.iface, address: chosen.address }),
      }
    }

    const literal = this.config.bindHost
    const local = this.options.localAddresses?.() ?? localIPv4Addresses()
    if (!local.includes(literal)) {
      return {
        kind: 'error',
        message: `${literal} is not an address on this machine`,
        mesh: base,
      }
    }
    const known = candidates.find((candidate) => candidate.address === literal)
    return {
      kind: 'ok',
      host: literal,
      urls: this.advertise([literal], tailscale),
      mesh: decorate({
        kind: known?.kind ?? (isCgnatIPv4(literal) ? 'mesh' : 'lan'),
        ...(known === undefined ? {} : { interface: known.iface }),
        address: literal,
      }),
    }
  }

  /**
   * Build the advertised URLs for a set of bound addresses.
   * @param addresses - addresses the listener accepts on.
   * @param tailscale - last known Tailscale state.
   * @returns URLs, MagicDNS name first.
   */
  private advertise(addresses: readonly string[], tailscale?: TailscaleState): string[] {
    const port = this.config.port
    const urls: string[] = []
    // A MagicDNS name works from every tailnet device and survives a changed
    // address, so it leads when Tailscale reports one for this node.
    if (tailscale?.dnsName !== undefined && addresses.length > 0) {
      urls.push(`http://${tailscale.dnsName}:${port}/`)
    }
    for (const address of addresses) {
      const url = `http://${address.includes(':') ? `[${address}]` : address}:${port}/`
      if (!urls.includes(url)) urls.push(url)
    }
    return urls
  }

  /** Bind one address and port, resolving once the attempt has settled. */
  private bind(host: string, port: number): Promise<void> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res)
      })
      server.on('upgrade', (req, socket, head) => {
        void this.handleUpgrade(req, socket, head)
      })
      server.on('connection', (socket) => {
        this.sockets.add(socket)
        socket.on('close', () => this.sockets.delete(socket))
      })
      const key = `${host}:${port}`
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        this.server = undefined
        this.bindKey = undefined
        this.bound = undefined
        const message = messageOf(error)
        if (this.error !== message) {
          this.logger.warn(`[dsh-remote-access] cannot listen on ${key}: ${message}`)
        }
        this.error = message
        this.scheduleRetry()
        resolve()
      }
      const onListening = (): void => {
        server.off('error', onError)
        const address = server.address()
        if (address === null || typeof address === 'string') {
          onError(new Error('the listener bound no TCP port'))
          return
        }
        server.on('error', (error) => {
          this.logger.warn(`[dsh-remote-access] listener error: ${messageOf(error)}`)
        })
        this.server = server
        this.bindKey = key
        this.bound = { address: host, port: (address as AddressInfo).port }
        this.error = undefined
        this.since = new Date(this.options.now?.() ?? Date.now()).toISOString()
        this.logger.info(
          `[dsh-remote-access] listening on http://${host}:${this.bound.port}/ (upstream 127.0.0.1:${this.options.upstream().port})`,
        )
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      try {
        server.listen(port, host)
      } catch (error) {
        onError(error as Error)
      }
    })
  }

  /** Close the socket and every connection it owns. */
  private async shutdownListener(): Promise<void> {
    this.clearRetry()
    const server = this.server
    this.server = undefined
    this.bindKey = undefined
    this.bound = undefined
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    for (const socket of this.upstreamSockets) socket.destroy()
    this.upstreamSockets.clear()
    if (server === undefined) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000)
      timer.unref?.()
      server.close(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /** Retry a bind that could not succeed, because the interface may come back. */
  private scheduleRetry(): void {
    if (!this.config.enabled || this.disposed) return
    this.retryTimer ??= setTimeout(() => {
      this.retryTimer = undefined
      void this.reconcile()
    }, this.retryMs)
    this.retryTimer.unref?.()
  }

  /** Cancel a pending retry. */
  private clearRetry(): void {
    if (this.retryTimer === undefined) return
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  /** Handle one HTTP request: gate, then proxy. */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'mesh.local'}`)
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    if (url.pathname === GATEWAY.unlock) {
      await this.handleUnlock(req, res, url)
      return
    }
    if (!this.authorize(req, res, url)) return
    this.forward(req, res, 0)
  }

  /**
   * Decide whether this request may reach the harness.
   * @param req - the request.
   * @param res - its response, written when the answer is a challenge.
   * @param url - parsed URL, whose `key` is honoured once.
   * @returns true when the request should be proxied.
   */
  private authorize(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (!this.config.requireKey) return true
    const key = this.options.key()
    if (isSessionValid(req.headers.cookie, key)) return true

    const presented = url.searchParams.get('key')
    if (presented !== null && keyMatches(presented, key)) {
      const next = withoutKey(req.url ?? '/')
      res.writeHead(303, {
        location: next,
        'set-cookie': sessionCookie(key),
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      })
      res.end()
      return false
    }

    this.challenge(req, res, url, presented === null ? undefined : 'That key is not right.')
    return false
  }

  /** Answer an unauthenticated request with the unlock page or a JSON refusal. */
  private challenge(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    error: string | undefined,
    status: number = 401,
  ): void {
    if (status === 429) {
      res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('Too many attempts. Wait a few minutes and try again.\n')
      return
    }
    if (wantsJson(req, url)) {
      const body = JSON.stringify({ error: 'mesh-auth-required', message: 'enter the access key on this node' })
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      })
      res.end(body)
      return
    }
    const authority = req.headers.host ?? 'this node'
    const html = unlockPage({
      authority,
      next: safeNext(url.pathname + url.search),
      ...(error === undefined ? {} : { error }),
    })
    res.writeHead(401, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
    })
    res.end(html)
  }

  /** Serve and process the unlock form. */
  private async handleUnlock(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const key = this.options.key()
    const client = req.socket.remoteAddress ?? 'unknown'
    if (!this.config.requireKey) {
      res.writeHead(303, { location: safeNext(url.searchParams.get('next')) })
      res.end()
      return
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (isSessionValid(req.headers.cookie, key)) {
        res.writeHead(303, { location: safeNext(url.searchParams.get('next')), 'cache-control': 'no-store' })
        res.end()
        return
      }
      const html = unlockPage({
        authority: req.headers.host ?? 'this node',
        next: safeNext(url.searchParams.get('next')),
      })
      res.writeHead(401, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      })
      res.end(html)
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, HEAD, POST' })
      res.end()
      return
    }
    if (this.limiter.isBlocked(client)) {
      this.challenge(req, res, url, undefined, 429)
      return
    }
    const body = await this.readBody(req)
    if (body === undefined) {
      res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Request body too large.\n')
      return
    }
    const form = new URLSearchParams(body)
    const presented = form.get('key') ?? ''
    const next = safeNext(form.get('next'))
    if (!keyMatches(presented, key)) {
      this.limiter.recordFailure(client)
      this.challenge(req, res, url, 'That key is not right.')
      return
    }
    this.limiter.clear(client)
    this.limiter.sweep()
    res.writeHead(303, {
      location: next,
      'set-cookie': sessionCookie(key),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end()
  }

  /**
   * Read a bounded request body.
   * @param req - the request.
   * @returns the body, or undefined when it exceeds the cap.
   */
  private readBody(req: IncomingMessage): Promise<string | undefined> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const finish = (value: string | undefined): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_UNLOCK_BODY) {
          finish(undefined)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => finish(undefined))
    })
  }

  /** Build the loopback request headers for one proxied request. */
  private upstreamHeaders(
    req: IncomingMessage,
    host: string,
    port: number,
    cookie: string | undefined,
    upgrade: boolean,
  ): Record<string, string | string[]> {
    const skip = upgrade ? UPGRADE_SKIP : HOP_BY_HOP
    const out: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (skip.has(lower)) continue
      out[lower] = value
    }
    out.host = `${host.includes(':') ? `[${host}]` : host}:${port}`
    if (cookie !== undefined) out.cookie = cookie
    out[PROXY_MARKER] = '1'
    return out
  }

  /** Replay one HTTP request against the harness. */
  private forward(req: IncomingMessage, res: ServerResponse, attempt: number): void {
    const { host, port } = this.options.upstream()
    if (port === 0) {
      const body = JSON.stringify({ error: 'upstream-unavailable', message: 'the harness web server has not bound a port yet' })
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
      return
    }
    // The raw target, not a parsed URL: see `withoutKey`.
    const path = withoutKey(req.url ?? '/')
    void this.cookie().then((cookie) => {
      if (res.writableEnded || res.destroyed) return
      const headers = this.upstreamHeaders(req, host, port, cookie, false)
      const upstream = httpRequest(
        { host, port, method: req.method, path, headers },
        (upstreamRes) => {
          const status = upstreamRes.statusCode ?? 502
          const idempotent = req.method === 'GET' || req.method === 'HEAD'
          if (status === 401 && attempt === 0 && idempotent) {
            // The minted cookie outlived its signing record; exchange again.
            upstreamRes.resume()
            this.invalidateCookie()
            this.forward(req, res, attempt + 1)
            return
          }
          const responseHeaders: Record<string, string | string[]> = {}
          for (const [name, value] of Object.entries(upstreamRes.headers)) {
            if (value === undefined) continue
            if (RESPONSE_DROP.has(name.toLowerCase())) continue
            responseHeaders[name] = value
          }
          res.writeHead(status, responseHeaders)
          upstreamRes.pipe(res)
          upstreamRes.on('error', () => res.destroy())
        },
      )
      upstream.on('error', (error) => {
        if (res.headersSent) {
          res.destroy()
          return
        }
        const body = JSON.stringify({ error: 'upstream-unreachable', message: messageOf(error) })
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(body)
      })
      req.pipe(upstream)
      req.on('aborted', () => upstream.destroy())
      res.on('close', () => {
        if (!res.writableEnded) upstream.destroy()
      })
    })
  }

  /** Replay one WebSocket upgrade as a raw tunnel. */
  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      if (this.config.requireKey && !isSessionValid(req.headers.cookie, this.options.key())) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
        socket.destroy()
        return
      }
      const { host, port } = this.options.upstream()
      if (port === 0) {
        socket.destroy()
        return
      }
      const cookie = await this.cookie()
      const headers = this.upstreamHeaders(req, host, port, cookie, true)
      const lines = [`GET ${withoutKey(req.url ?? '/')} HTTP/1.1`]
      for (const [name, value] of Object.entries(headers)) {
        for (const entry of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${entry}`)
      }
      const upstream = connect(port, host)
      this.upstreamSockets.add(upstream)
      upstream.on('close', () => this.upstreamSockets.delete(upstream))
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
      socket.on('close', () => upstream.destroy())
      const timer = setTimeout(() => upstream.destroy(), 15_000)
      timer.unref?.()
      upstream.once('connect', () => {
        clearTimeout(timer)
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (head.length > 0) upstream.write(head)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
    } catch (error) {
      this.logger.warn(`[dsh-remote-access] upgrade failed: ${messageOf(error)}`)
      socket.destroy()
    }
  }

  /**
   * The harness browser cookie, minting it when necessary.
   * @returns `name=value`, or undefined when the process offers no launch URL.
   */
  private cookie(): Promise<string | undefined> {
    if (this.cachedCookie !== undefined) return Promise.resolve(this.cachedCookie)
    this.minting ??= this.mintCookie().finally(() => {
      this.minting = undefined
    })
    return this.minting
  }

  /** Exchange the launch token for a cookie, against loopback. */
  private async mintCookie(): Promise<string | undefined> {
    const launchUrl = this.options.launchUrl()
    if (launchUrl === undefined) {
      this.logger.warn('[dsh-remote-access] no launch URL: proxied calls will be refused by the harness')
      return undefined
    }
    const { host, port } = this.options.upstream()
    if (port === 0) return undefined
    let target: URL
    try {
      const original = new URL(launchUrl)
      target = new URL(`http://${host}:${port}${original.pathname}${original.search}`)
    } catch {
      this.logger.warn('[dsh-remote-access] the launch URL was unparseable; proxying unauthenticated')
      return undefined
    }
    const cookie = await new Promise<string | undefined>((resolve) => {
      const request = httpRequest(
        {
          host,
          port,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: { host: `${host}:${port}`, 'cache-control': 'no-store' },
        },
        (response) => {
          response.resume()
          const raw = response.headers['set-cookie']
          const first = Array.isArray(raw) ? raw[0] : raw
          resolve(first?.split(';')[0]?.trim() ?? undefined)
        },
      )
      request.on('error', (error) => {
        this.logger.warn(`[dsh-remote-access] cookie exchange failed: ${messageOf(error)}`)
        resolve(undefined)
      })
      request.setTimeout(5_000, () => request.destroy(new Error('cookie exchange timed out')))
      request.end()
    })
    if (cookie !== undefined) {
      this.cachedCookie = cookie
      this.logger.debug('[dsh-remote-access] minted a browser session for proxied traffic')
    }
    return cookie
  }
}
