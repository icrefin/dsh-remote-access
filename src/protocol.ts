/**
 * Wire contract shared by both halves.
 *
 * Both halves import this module, so a route path, a config field or a payload
 * shape can never drift between the host that answers it and the page that
 * reads it. Keep it dependency-free: the client bundle inlines it.
 *
 * @module dsh-remote-access/protocol
 */

/** Loader row id; also the locale namespace and the settings namespace. */
export const PLUGIN_ID = 'dsh-remote-access'

/** Package version, mirrored in `package.json` and pinned by a test. */
export const VERSION = '0.1.4'

/** Route paths served by the host half under the web server's route table. */
export const API = {
  /** Current listener, detected mesh facts, and the last bind error. */
  status: '/api/dsh-remote-access/status',
  /** Read or change the live settings: enabled, port, bindHost, requireKey. */
  config: '/api/dsh-remote-access/config',
  /** The access key and the ready-to-open URLs that carry it. */
  key: '/api/dsh-remote-access/key',
  /** Replace the access key; every issued browser cookie stops working. */
  regenerate: '/api/dsh-remote-access/regenerate',
} as const

/**
 * Re-express a host route as the browser half must request it.
 *
 * A route beginning with `/` is origin-absolute, which is correct only while
 * the client is served at the origin root. The client can also be mounted under
 * a path prefix (`dsh-remote-control` serves it at `/s/<sessionId>/`), and an
 * absolute request then escapes that mount. Dropping the leading slash makes
 * the request resolve against `document.baseURI`, which is how the harness's
 * own channels address the host.
 *
 * @param route - a host route path from {@link API}.
 * @returns the same route, relative to the document.
 */
export function clientPath(route: string): string {
  return route.replace(/^\//, '')
}

/** The {@link API} routes as the browser half requests them. */
export const CLIENT_API = {
  status: clientPath(API.status),
  config: clientPath(API.config),
  key: clientPath(API.key),
  regenerate: clientPath(API.regenerate),
} as const

/** Paths the gateway itself answers, before the proxy. */
export const GATEWAY = {
  /** Unlock page and its form target. */
  unlock: '/__remote/unlock',
} as const

/** Name of the cookie this gateway issues after a successful unlock. */
export const MESH_COOKIE = 'dsh_remote_session'

/** How a bind host was resolved. */
export type BindMode = 'auto' | 'all' | 'address'

/** Split, mutable settings of the listener. */
export interface MeshConfig {
  /** Whether the listener should run. */
  enabled: boolean
  /** TCP port on the mesh address. */
  port: number
  /** `auto` (detected mesh interface), `all` (0.0.0.0), or an IPv4 literal. */
  bindHost: string
  /**
   * Whether a browser must present the access key before it is proxied.
   *
   * Off by default: the private mesh is the trust boundary this plugin is built
   * for. The key stays available as an opt-in hardening for a shared tailnet.
   */
  requireKey: boolean
}

/** Built-in defaults; the plugin binds nothing until `enabled` is true. */
export const DEFAULT_CONFIG: MeshConfig = {
  enabled: false,
  port: 3080,
  bindHost: 'auto',
  requireKey: false,
}

/** Facts about the network interface the listener uses. */
export interface MeshFacts {
  /** `mesh` = carrier-grade NAT range (Tailscale and friends), `lan` = RFC1918. */
  kind: 'mesh' | 'lan' | 'all' | 'none'
  /** Interface name, for example `utun4`. */
  interface?: string
  /** The IPv4 address the listener binds, or `0.0.0.0`. */
  address?: string
  /** Tailscale host name when the CLI reports one. */
  nodeName?: string
  /** Tailscale MagicDNS name when the CLI reports one. */
  dnsName?: string
  /** Tailnet name when the CLI reports one. */
  tailnet?: string
  /** Whether Tailscale reports this node online. */
  online?: boolean
}

/** Body of `GET API.status`. */
export interface MeshStatus {
  /** Loader row id, so the panel can prove which plugin answered. */
  id: string
  /** Package version. */
  version: string
  /** Whether the listener is wanted. */
  enabled: boolean
  /** Whether a socket is bound right now. */
  bound: boolean
  /** Bind address in use, or the address that will be used. */
  address: string
  /** Configured bind mode: `auto`, `all`, or one IPv4 literal. */
  bindHost: string
  /** Port in use, or the configured port. */
  port: number
  /** `http:` — this listener never terminates TLS itself. */
  scheme: 'http'
  /** Every URL a client can open, best first. */
  urls: string[]
  /** Whether an access key is required. */
  keyRequired: boolean
  /** Whether a key has been generated yet. */
  hasKey: boolean
  /** Loopback port of the harness web server the gateway proxies to. */
  upstreamPort: number
  /** Detected interface facts. */
  mesh: MeshFacts
  /** Last bind or resolve failure, if the listener is not bound. */
  error?: string
  /** ISO timestamp of the last successful bind. */
  since?: string
}

/** Body of `POST API.config`; absent fields keep their current value. */
export interface MeshConfigPatch {
  enabled?: boolean
  port?: number
  bindHost?: string
  requireKey?: boolean
}

/** Body of a successful config change. */
export interface MeshConfigResult {
  status: MeshStatus
  /** Whether the change reached the settings document. */
  saved: boolean
  /** Why the settings document could not be written, when it could not. */
  saveError?: string
}

/** Body of `GET API.key` and `POST API.regenerate`. */
export interface MeshKeyPayload {
  /** The access key browsers append as `?key=`. */
  key: string
  /** Ready-to-open URLs, each already carrying the key. */
  urls: string[]
}

/** Body of any failed request. */
export interface ErrorPayload {
  /** Stable machine-readable token. */
  error: string
  /** Human-readable detail. */
  message?: string
}