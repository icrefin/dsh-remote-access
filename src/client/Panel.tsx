/**
 * The Remote Access page.
 *
 * Three cards: what the listener is doing, the links a device on the mesh can
 * open, and the settings that decide where it listens. Every request path is the
 * document-relative `CLIENT_API`, not the host's absolute route, because the
 * client can be served under a path prefix (see `clientPath()`).
 *
 * @module dsh-remote-access/client/Panel
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  CLIENT_API,
  VERSION,
  type ErrorPayload,
  type MeshConfigResult,
  type MeshKeyPayload,
  type MeshStatus,
} from '../protocol.ts'
import type { PanelTranslate } from './locales.ts'

/** Props composed by the slot framework for this key of the `main` slot. */
export interface PanelProps {
  /** Framework-injected translate seat. */
  t: PanelTranslate
}

/** How the bind address control is spelled. */
type BindMode = 'auto' | 'all' | 'custom'

/**
 * Hide the key inside a link until a person asks to see it.
 * @param url - a link that carries `?key=`.
 * @returns the same link with the key replaced by bullets.
 */
function maskUrl(url: string): string {
  return url.replace(/key=[^&]*/u, 'key=••••••••')
}

/**
 * The eye glyph, drawn in `currentColor`.
 * @param props - whether the key is currently visible.
 * @returns the inline SVG.
 */
function EyeIcon({ open }: { open: boolean }): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 8s2.4-4.25 6.5-4.25S14.5 8 14.5 8 12.1 12.25 8 12.25 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="1.9" />
      {open ? null : <path d="M2.5 13.5 13.5 2.5" />}
    </svg>
  )
}

/** Human-readable form of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Call one host route and decode its JSON body.
 * @param path - document-relative route.
 * @param init - fetch options.
 * @returns the parsed body.
 * @throws when the response is not ok or not JSON.
 */
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { accept: 'application/json', ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }) },
  })
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    try {
      const body = (await response.json()) as ErrorPayload
      if (body.error !== undefined) detail = body.message ?? body.error
    } catch {
      // A non-JSON body keeps the status line.
    }
    throw new Error(detail)
  }
  return (await response.json()) as T
}

/**
 * Derive the control spelling from a configured bind host.
 * @param bindHost - `auto`, `all`, or an IPv4 literal.
 * @returns the mode and, for a literal, its text.
 */
function readBind(bindHost: string): { mode: BindMode; host: string } {
  if (bindHost === 'auto') return { mode: 'auto', host: '' }
  if (bindHost === 'all') return { mode: 'all', host: '' }
  return { mode: 'custom', host: bindHost }
}

/**
 * Render the panel.
 * @param props - the framework-injected translate seat.
 * @returns the panel element tree.
 */
export function Panel({ t }: PanelProps): ReactElement {
  const [status, setStatus] = useState<MeshStatus | undefined>(undefined)
  const [access, setAccess] = useState<MeshKeyPayload | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<'saved' | 'notSaved' | undefined>(undefined)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState<string | undefined>(undefined)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const keyRequired = status?.keyRequired === true

  const [portDraft, setPortDraft] = useState('3080')
  const [mode, setMode] = useState<BindMode>('auto')
  const [customHost, setCustomHost] = useState('')
  const [requireKeyDraft, setRequireKeyDraft] = useState(true)

  /** Load status and the key together; the key is what the links need. */
  const load = useCallback(async (): Promise<void> => {
    setError(undefined)
    try {
      const [nextStatus, nextAccess] = await Promise.all([
        requestJson<MeshStatus>(CLIENT_API.status),
        requestJson<MeshKeyPayload>(CLIENT_API.key),
      ])
      setStatus(nextStatus)
      setAccess(nextAccess)
    } catch (caught) {
      setError(messageOf(caught))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Drafts follow the host until the user edits them; an applied change comes
  // back through the same status, so the two never disagree for long.
  useEffect(() => {
    if (status === undefined) return
    setPortDraft(String(status.port))
    const parsed = readBind(status.bindHost)
    setMode(parsed.mode)
    setCustomHost(parsed.host)
    setRequireKeyDraft(status.keyRequired)
  }, [status])

  /** Flip the listener on or off. */
  const toggle = useCallback(async (): Promise<void> => {
    if (status === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await requestJson<MeshConfigResult>(CLIENT_API.config, {
        method: 'POST',
        body: JSON.stringify({ enabled: !status.enabled }),
      })
      setStatus(result.status)
      setAccess(await requestJson<MeshKeyPayload>(CLIENT_API.key))
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }, [status])

  /** Persist port, bind host and key policy. */
  const applySettings = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    setSaveError(undefined)
    try {
      const port = Number(portDraft)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(t('port'))
      }
      if (mode === 'custom' && customHost.trim().length === 0) {
        throw new Error(t('customPlaceholder'))
      }
      const bindHost = mode === 'custom' ? customHost.trim() : mode
      const result = await requestJson<MeshConfigResult>(CLIENT_API.config, {
        method: 'POST',
        body: JSON.stringify({ port, bindHost, requireKey: requireKeyDraft }),
      })
      setStatus(result.status)
      setAccess(await requestJson<MeshKeyPayload>(CLIENT_API.key))
      if (!result.saved) {
        setNotice('notSaved')
        if (result.saveError !== undefined) setSaveError(result.saveError)
      } else {
        setNotice('saved')
      }
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }, [customHost, mode, portDraft, requireKeyDraft, t])

  /** Replace the key and show the new links. */
  const regenerate = useCallback(async (): Promise<void> => {
    if (!window.confirm(t('regenerateConfirm'))) return
    setBusy(true)
    setError(undefined)
    try {
      setAccess(await requestJson<MeshKeyPayload>(CLIENT_API.regenerate, { method: 'POST' }))
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }, [t])

  /** Copy one link, falling back to a selection when the clipboard is denied. */
  const copy = useCallback(async (url: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(url)
      window.setTimeout(() => setCopied((current) => (current === url ? undefined : current)), 1_500)
    } catch {
      setCopied(undefined)
    }
  }, [])

  const networkLabel = useMemo(() => {
    if (status === undefined) return '—'
    const mesh = status.mesh
    const base =
      mesh.kind === 'mesh'
        ? t('networkMesh')
        : mesh.kind === 'lan'
          ? t('networkLan')
          : mesh.kind === 'all'
            ? t('networkAll')
            : t('networkNone')
    const name = mesh.dnsName ?? mesh.nodeName
    return name === undefined ? base : `${base} · ${name}`
  }, [status, t])

  const pillClass =
    status?.bound === true
      ? 'dra-pill dra-pill-on'
      : status?.enabled === true
        ? 'dra-pill dra-pill-wait'
        : 'dra-pill'

  const pillLabel =
    status === undefined
      ? '—'
      : status.bound
        ? t('listening')
        : status.enabled
          ? t('starting')
          : t('idle')

  return (
    <div className="dra-page">
      <div className="dra-inner">
        <header className="dra-header">
          <div className="dra-titleRow">
            <h1 className="dra-title">{t('title')}</h1>
            <span className="dra-chip">{t('credit', { version: VERSION })}</span>
          </div>
          <p className="dra-intro">{t('description')}</p>
        </header>

        {error === undefined ? null : (
          <div className="dra-error" role="alert">
            {t('loadFailed')}: {error}
          </div>
        )}

        <section className="dra-card">
          <div className="dra-cardHead">
            <h2 className="dra-subtitle">{t('status')}</h2>
            <span className={pillClass}>{pillLabel}</span>
          </div>
          <dl className="dra-facts">
            <div className="dra-fact">
              <dt>{t('address')}</dt>
              <dd>{status === undefined || status.address.length === 0 ? '—' : `${status.address}:${status.port}`}</dd>
            </div>
            <div className="dra-fact">
              <dt>{t('meshNetwork')}</dt>
              <dd>{networkLabel}</dd>
            </div>
            <div className="dra-fact">
              <dt>{t('upstream')}</dt>
              <dd>127.0.0.1:{status?.upstreamPort ?? '—'}</dd>
            </div>
          </dl>
          {status?.error === undefined ? null : (
            <p className="dra-error dra-errorInline" role="status">
              {status.error}
            </p>
          )}
          <div className="dra-actions">
            <button type="button" className="dra-button dra-button-primary" onClick={() => void toggle()} disabled={busy || status === undefined}>
              {busy ? t('enabling') : status?.enabled === true ? t('disable') : t('enable')}
            </button>
            <button type="button" className="dra-button" onClick={() => void load()} disabled={busy}>
              {t('retry')}
            </button>
          </div>
          {status?.enabled === true && status.bound === false ? (
            <div className="dra-note">
              <strong>{t('noMeshTitle')}</strong>
              <p>{t('noMeshHint')}</p>
            </div>
          ) : null}
        </section>

        <section className="dra-card">
          <h2 className="dra-subtitle">{t('access')}</h2>
          <p className="dra-hint">{t('accessHint')}</p>
          {(access?.urls.length ?? 0) === 0 ? (
            <p className="dra-hint">{t('noUrls')}</p>
          ) : (
            <ul className="dra-links">
              {access?.urls.map((url) => (
                <li key={url} className="dra-linkRow">
                  {keyRequired ? (
                    <div className="dra-secret">
                      <input
                        className="dra-input dra-inputMono dra-inputSecret"
                        readOnly
                        value={revealed[url] === true ? url : maskUrl(url)}
                        aria-label={t('access')}
                        onFocus={(event) => event.currentTarget.select()}
                      />
                      <button
                        type="button"
                        className="dra-eye"
                        aria-label={revealed[url] === true ? t('hideKey') : t('showKey')}
                        title={revealed[url] === true ? t('hideKey') : t('showKey')}
                        onClick={() => setRevealed((current) => ({ ...current, [url]: current[url] !== true }))}
                      >
                        <EyeIcon open={revealed[url] === true} />
                      </button>
                    </div>
                  ) : (
                    <input
                      className="dra-input dra-inputMono"
                      readOnly
                      value={url}
                      aria-label={t('access')}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  )}
                  <button type="button" className="dra-button" onClick={() => void copy(url)}>
                    {copied === url ? t('copied') : t('copy')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="dra-hint">{keyRequired ? t('keyHint') : t('openHint')}</p>
          {keyRequired && access !== undefined && access.urls.length > 0 ? (
            <div className="dra-actions">
              <button type="button" className="dra-button dra-button-danger" onClick={() => void regenerate()} disabled={busy}>
                {t('regenerate')}
              </button>
            </div>
          ) : null}
        </section>

        <section className="dra-card">
          <h2 className="dra-subtitle">{t('settings')}</h2>
          <div className="dra-field">
            <label className="dra-label" htmlFor="dra-port">
              {t('port')}
            </label>
            <input
              id="dra-port"
              className="dra-input dra-inputShort"
              inputMode="numeric"
              value={portDraft}
              onChange={(event) => setPortDraft(event.target.value)}
            />
          </div>
          <div className="dra-field">
            <label className="dra-label" htmlFor="dra-bind">
              {t('bindAddress')}
            </label>
            <select
              id="dra-bind"
              className="dra-input"
              value={mode}
              onChange={(event) => setMode(event.target.value as BindMode)}
            >
              <option value="auto">{t('bindAuto')}</option>
              <option value="all">{t('bindAll')}</option>
              <option value="custom">{t('bindCustom')}</option>
            </select>
            {mode === 'custom' ? (
              <input
                className="dra-input dra-inputMono"
                placeholder={t('customPlaceholder')}
                value={customHost}
                onChange={(event) => setCustomHost(event.target.value)}
                aria-label={t('bindAddress')}
              />
            ) : null}
            {mode === 'all' ? <p className="dra-warning">{t('allWarning')}</p> : null}
          </div>
          <div className="dra-field dra-fieldRow">
            <label className="dra-switchLabel" htmlFor="dra-key">
              <input
                id="dra-key"
                type="checkbox"
                checked={requireKeyDraft}
                onChange={(event) => setRequireKeyDraft(event.target.checked)}
              />
              <span>{t('keyRequired')}</span>
            </label>
            <p className="dra-hint">{t('keyRequiredHint')}</p>
          </div>
          <div className="dra-actions">
            <button type="button" className="dra-button dra-button-primary" onClick={() => void applySettings()} disabled={busy}>
              {busy ? t('applying') : t('apply')}
            </button>
            {notice === 'saved' ? <span className="dra-saved">{t('saved')}</span> : null}
            {notice === 'notSaved' ? (
              <span className="dra-saved dra-saved-warn" title={saveError}>
                {t('notSaved')}
                {saveError === undefined ? '' : `: ${saveError}`}
              </span>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}