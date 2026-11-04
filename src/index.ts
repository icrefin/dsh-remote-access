/**
 * dsh-remote-access — host half.
 *
 * Puts this harness's web GUI on a private mesh network, such as Tailscale,
 * without changing how the harness itself listens. The gateway binds one
 * concrete mesh address, authenticates the browser with its own key, and
 * replays requests against the harness's loopback listener — see
 * `mesh/gateway.ts` for why that is the honest option.
 *
 * Every registration lives inside `ctx.effect`, whose callback returns the
 * disposer; cordis runs it when the plugin unloads, when the profile patch
 * disables the row, or when the host tears down.
 *
 * @module dsh-remote-access
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only import for the declaration merging that puts `webServer` on Context.
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_CONFIG, PLUGIN_ID, VERSION, type MeshConfig, type MeshConfigPatch } from './protocol.ts'
import { TailscaleProbe } from './mesh/detect.ts'
import { MeshGateway } from './mesh/gateway.ts'
import { ensureKey, readKey, regenerateKey } from './mesh/secret.ts'
import { makeRoutes } from './routes.ts'

/** Loader row id; mirrors `cordis.patch.yml`. */
export const name = PLUGIN_ID

/** Services required before this plugin may mount. */
export const inject = ['webServer']

/**
 * The row's Config, which is also its settings namespace.
 *
 * Every field is volatile, which is what makes it writable at runtime: the
 * settings service refuses a namespace with no volatile field, and the Loader
 * applies a write in place on the running fiber. The panel therefore saves a
 * change and sees it take effect without a restart, and the value survives the
 * next one.
 */
export const Config = z.object({
  /** Whether the mesh listener should run. Off until a person turns it on. */
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled).volatile(),
  /** TCP port on the mesh address. */
  port: z.number().step(1).min(1).max(65535).default(DEFAULT_CONFIG.port).volatile(),
  /** `auto`, `all`, or one IPv4 literal of a local interface. */
  bindHost: z.string().default(DEFAULT_CONFIG.bindHost).volatile(),
  /** Whether a browser must present the access key before it is proxied. */
  requireKey: z.boolean().default(DEFAULT_CONFIG.requireKey).volatile(),
})

/** A volatile config value, in either shape a mount can produce. */
type Volatile<T> = T | { get(): unknown } | undefined

/** Resolved config, as the loader hands it to {@link apply}. */
export type MeshConfigFields = {
  enabled?: Volatile<boolean>
  port?: Volatile<number>
  bindHost?: Volatile<string>
  requireKey?: Volatile<boolean>
}

/**
 * Read one volatile field.
 * @param field - the config field, in either shape.
 * @param fallback - value to use when the field is absent.
 * @returns the current value.
 */
function readField<T>(field: Volatile<T>, fallback: T): T {
  if (field === undefined || field === null) return fallback
  const value = typeof (field as { get?: unknown }).get === 'function'
    ? (field as { get(): unknown }).get()
    : field
  return (value === undefined || value === null ? fallback : value) as T
}

/** The slice of the harness Connection service this plugin uses. */
interface ConnectionLike {
  /**
   * Add this process's launch token to a clean application URL, so a request
   * to it exchanges the token for a browser-session cookie.
   * @param baseUrl - clean URL whose authority and mount are preserved.
   * @returns the same URL carrying the process token.
   */
  authenticatedUrl(baseUrl: string): string
}

/** The slice of the harness settings service this plugin uses. */
interface SettingsLike {
  /**
   * Patch one namespace.
   * @param ns - namespace, which is the loader row id.
   * @param patch - the values to write.
   * @returns resolves once the document is written.
   */
  update(ns: string, patch: Record<string, unknown>): Promise<void>
}

/**
 * Mount the listener, its route family, and the fact refresh timer.
 * @param ctx - host plugin context.
 * @param config - the row's configuration.
 */
export function apply(ctx: Context, config: MeshConfigFields = {}): void {
  ctx.effect(() => {
    const logger = {
      debug: (message: string): void => ctx.logger.debug(message),
      info: (message: string): void => ctx.logger.info(message),
      warn: (message: string): void => ctx.logger.warn(message),
      error: (message: string): void => ctx.logger.error(message),
    }

    /** The initial settings, read once; later writes go through the gateway. */
    const initial: MeshConfig = {
      enabled: readField(config.enabled, DEFAULT_CONFIG.enabled),
      port: readField(config.port, DEFAULT_CONFIG.port),
      bindHost: readField(config.bindHost, DEFAULT_CONFIG.bindHost),
      requireKey: readField(config.requireKey, DEFAULT_CONFIG.requireKey),
    }

    const probe = new TailscaleProbe()

    /**
     * The loopback endpoint of the harness web server.
     *
     * The gateway dials exactly the address the harness bound — normally
     * `127.0.0.1` — and reads the port per request, because it is `0` until the
     * listener binds and may change on a reload.
     */
    const upstream = (): { host: string; port: number } => ({
      host: ctx.webServer.host ?? '127.0.0.1',
      port: ctx.webServer.port ?? 0,
    })

    /**
     * A clean loopback URL carrying this process's launch token.
     *
     * Looked up on demand: the Connection row may activate after this one, and
     * `ctx.get` is a live lookup.
     * @returns the tokenized URL, or undefined when Connection is absent.
     */
    const launchUrl = (): string | undefined => {
      const connection = ctx.get('connection') as ConnectionLike | undefined
      if (connection === undefined) return undefined
      const port = ctx.webServer.port
      if (port === undefined) return undefined
      try {
        return connection.authenticatedUrl(`http://127.0.0.1:${port}/`)
      } catch {
        return undefined
      }
    }

    const gateway = new MeshGateway({
      logger,
      upstream,
      launchUrl,
      key: () => ensureKey(),
      // No key is minted unless it is actually needed; `hasKey` only reports.
      hasKey: () => readKey().length > 0,
      initial,
      tailscale: probe,
      version: VERSION,
    })

    /** Persist a settings change; a missing service is reported, never fatal. */
    const persist = async (patch: MeshConfigPatch): Promise<{ saved: boolean; saveError?: string }> => {
      const settings = ctx.get('settings') as SettingsLike | undefined
      if (settings === undefined) {
        return { saved: false, saveError: 'this composition has no settings service' }
      }
      try {
        await settings.update(name, patch as Record<string, unknown>)
        return { saved: true }
      } catch (error) {
        return { saved: false, saveError: error instanceof Error ? error.message : String(error) }
      }
    }

    const disposers = makeRoutes({
      logger,
      gateway,
      key: () => ensureKey(),
      regenerate: () => regenerateKey(),
      persist,
    }).map((route) => ctx.webServer.register(route))

    void gateway.reconcile()

    // Tailscale may start after the harness, and a MagicDNS name may appear
    // once it does; a periodic reconcile refreshes the advertised URLs without
    // disturbing a listener that is already bound.
    const timer = setInterval(() => {
      void gateway.reconcile()
    }, 60_000)
    timer.unref?.()

    logger.info(`[${PLUGIN_ID}] mesh access ${initial.enabled ? 'starting' : 'idle'} (v${VERSION})`)

    return async () => {
      clearInterval(timer)
      for (const dispose of disposers) dispose()
      await gateway.dispose()
    }
  }, 'dsh-remote-access: gateway')
}