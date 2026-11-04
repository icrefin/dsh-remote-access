/**
 * The `/api/dsh-remote-access` route family.
 *
 * These routes are the panel's only channel to the listener. They are matched
 * before the authenticated SPA fallback and are not covered by the harness
 * launch token, so each one carries its own fence: a loopback source, a known
 * method, and a bounded body. Through the gateway, proxied requests arrive from
 * loopback too, which is deliberate — a browser that reached the panel through
 * the mesh has already proved possession of the key.
 *
 * @module dsh-remote-access/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  API,
  PLUGIN_ID,
  type ErrorPayload,
  type MeshConfigPatch,
  type MeshConfigResult,
  type MeshKeyPayload,
} from './protocol.ts'
import { parseIPv4 } from './mesh/detect.ts'
import type { MeshGateway } from './mesh/gateway.ts'

/** Largest JSON body accepted on a mutating route, in bytes. */
const MAX_BODY = 16 * 1024

/** Minimal logging seam shared with the host half. */
export interface RouteLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** What the routes need from the plugin. */
export interface MeshRouteDeps {
  /** Diagnostics. */
  logger: RouteLogger
  /** The live listener. */
  gateway: MeshGateway
  /** The current access key, minting one on first use. */
  key: () => string
  /** Replace the access key. */
  regenerate: () => string
  /** Write settings through the harness settings service. */
  persist: (patch: MeshConfigPatch) => Promise<{ saved: boolean; saveError?: string }>
}

/** Write one JSON response body. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** Write one JSON error body. */
function writeError(res: ServerResponse, status: number, error: string, message?: string): void {
  const body: ErrorPayload = message === undefined ? { error } : { error, message }
  writeJson(res, status, body)
}

/** Whether the request arrived over the loopback interface. */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Read a bounded JSON body.
 * @param req - the request.
 * @returns the parsed value, or a failure token.
 */
function readJson(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (result: { ok: true; value: unknown } | { ok: false; error: string }): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        finish({ ok: false, error: 'body-too-large' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) {
        finish({ ok: true, value: {} })
        return
      }
      try {
        finish({ ok: true, value: JSON.parse(text) })
      } catch {
        finish({ ok: false, error: 'invalid-json' })
      }
    })
    req.on('error', () => finish({ ok: false, error: 'body-read-failed' }))
  })
}

/**
 * Validate one settings patch off the wire.
 * @param value - parsed JSON body.
 * @returns the patch, or a failure token.
 */
export function normalizePatch(value: unknown): { ok: true; patch: MeshConfigPatch } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null) return { ok: false, error: 'invalid-patch' }
  const input = value as Record<string, unknown>
  const patch: MeshConfigPatch = {}
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return { ok: false, error: 'enabled-must-be-boolean' }
    patch.enabled = input.enabled
  }
  if (input.requireKey !== undefined) {
    if (typeof input.requireKey !== 'boolean') return { ok: false, error: 'require-key-must-be-boolean' }
    patch.requireKey = input.requireKey
  }
  if (input.port !== undefined) {
    if (typeof input.port !== 'number' || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
      return { ok: false, error: 'port-must-be-an-integer-1-65535' }
    }
    patch.port = input.port
  }
  if (input.bindHost !== undefined) {
    if (typeof input.bindHost !== 'string' || input.bindHost.length === 0) {
      return { ok: false, error: 'bind-host-must-be-a-string' }
    }
    const host = input.bindHost.trim()
    if (host !== 'auto' && host !== 'all' && parseIPv4(host) === undefined) {
      return { ok: false, error: 'bind-host-must-be-auto-all-or-an-ipv4-literal' }
    }
    patch.bindHost = host
  }
  return { ok: true, patch }
}

/**
 * Append the key to every advertised URL.
 * @param urls - base URLs.
 * @param key - the access key.
 * @returns URLs that unlock on first load.
 */
export function withKey(urls: readonly string[], key: string): string[] {
  return urls.map((url) => `${url}?key=${encodeURIComponent(key)}`)
}

/**
 * Build every route of the `/api/dsh-remote-access` family.
 * @param deps - gateway, key store and persistence seam.
 * @returns the exact-path routes to register on `ctx.webServer`.
 */
export function makeRoutes(deps: MeshRouteDeps): WebRoute[] {
  const { gateway } = deps

  const guarded = async (
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    handler: () => void | Promise<void>,
  ): Promise<void> => {
    if (!isLoopbackRequest(req)) {
      writeError(res, 403, 'forbidden', 'this route only answers the local machine')
      return
    }
    if (req.method !== method) {
      res.setHeader('allow', method)
      writeError(res, 405, 'method-not-allowed', `use ${method}`)
      return
    }
    deps.logger.debug(`[${PLUGIN_ID}] ${req.method ?? ''} ${req.url ?? ''}`)
    await handler()
  }

  return [
    {
      kind: 'exact',
      path: API.status,
      handler: async (req, res) => {
        await guarded(req, res, 'GET', () => {
          writeJson(res, 200, gateway.status())
        })
      },
    },
    {
      kind: 'exact',
      path: API.config,
      handler: async (req, res) => {
        await guarded(req, res, 'POST', async () => {
          const body = await readJson(req)
          if (!body.ok) {
            writeError(res, body.error === 'body-too-large' ? 413 : 400, body.error)
            return
          }
          const normalized = normalizePatch(body.value)
          if (!normalized.ok) {
            writeError(res, 400, normalized.error)
            return
          }
          try {
            await gateway.update(normalized.patch)
          } catch (error) {
            writeError(res, 500, 'apply-failed', error instanceof Error ? error.message : String(error))
            return
          }
          const persisted = await deps.persist(normalized.patch)
          const result: MeshConfigResult = {
            status: gateway.status(),
            saved: persisted.saved,
            ...(persisted.saveError === undefined ? {} : { saveError: persisted.saveError }),
          }
          writeJson(res, 200, result)
        })
      },
    },
    {
      kind: 'exact',
      path: API.key,
      handler: async (req, res) => {
        await guarded(req, res, 'GET', () => {
          const status = gateway.status()
          // With the key switched off the links are the links; minting a
          // credential nobody is asked for would be noise.
          if (!status.keyRequired) {
            writeJson(res, 200, { key: '', urls: status.urls } satisfies MeshKeyPayload)
            return
          }
          const key = deps.key()
          const payload: MeshKeyPayload = { key, urls: withKey(status.urls, key) }
          writeJson(res, 200, payload)
        })
      },
    },
    {
      kind: 'exact',
      path: API.regenerate,
      handler: async (req, res) => {
        await guarded(req, res, 'POST', () => {
          const status = gateway.status()
          if (!status.keyRequired) {
            writeJson(res, 200, { key: '', urls: status.urls } satisfies MeshKeyPayload)
            return
          }
          const key = deps.regenerate()
          const payload: MeshKeyPayload = { key, urls: withKey(status.urls, key) }
          writeJson(res, 200, payload)
        })
      },
    },
  ]
}