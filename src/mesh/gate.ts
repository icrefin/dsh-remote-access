/**
 * The browser credential this gateway believes.
 *
 * A tailnet is private, but "on my tailnet" is not the same as "allowed to run
 * an agent on this machine": a colleague's laptop, a shared exit node, or any
 * device that joined the tailnet with the same ACL would inherit full shell
 * access to this host. So the gateway issues its own cookie, and the key that
 * signs it never leaves this machine except in the URL a person copies once.
 *
 * The cookie is an HMAC of a constant under the access key: no server-side
 * session table, no expiry bookkeeping beyond `Max-Age`, and rotating the key
 * invalidates every browser at once, which is the point of rotating it.
 *
 * @module dsh-remote-access/mesh/gate
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { MESH_COOKIE } from '../protocol.ts'

/** Cookie lifetime in days. */
export const COOKIE_MAX_AGE_DAYS = 30

/** Failure budget per client address, and the window it is spent over. */
export const FAILURE_LIMIT = 8
export const FAILURE_WINDOW_MS = 15 * 60 * 1000

/**
 * The cookie value that proves possession of the key.
 * @param key - the access key.
 * @returns a URL-safe HMAC digest.
 */
export function sessionValue(key: string): string {
  return createHmac('sha256', key).update('dsh-remote-access/session/v1').digest('base64url')
}

/**
 * Read one cookie out of a request header.
 * @param header - the raw `cookie` header, when present.
 * @param name - cookie name to find.
 * @returns the decoded value, or undefined.
 */
export function readCookie(header: string | undefined, name: string = MESH_COOKIE): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== name) continue
    return decodeURIComponent(part.slice(separator + 1).trim())
  }
  return undefined
}

/**
 * Whether a request's cookies prove possession of the key.
 * @param header - the raw `cookie` header.
 * @param key - the current access key.
 * @returns true when the session cookie matches.
 */
export function isSessionValid(header: string | undefined, key: string): boolean {
  if (key.length === 0) return false
  const presented = readCookie(header)
  if (presented === undefined) return false
  const expected = Buffer.from(sessionValue(key))
  const actual = Buffer.from(presented)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/**
 * Build the `Set-Cookie` value that unlocks this browser.
 * @param key - the current access key.
 * @param maxAgeDays - cookie lifetime.
 * @returns the header value.
 */
export function sessionCookie(key: string, maxAgeDays: number = COOKIE_MAX_AGE_DAYS): string {
  const maxAge = Math.max(1, Math.round(maxAgeDays * 24 * 60 * 60))
  return `${MESH_COOKIE}=${sessionValue(key)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict`
}

/**
 * Build the `Set-Cookie` value that forgets one.
 * @returns the header value.
 */
export function clearedCookie(): string {
  return `${MESH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`
}

/**
 * Constant-time key comparison.
 * @param presented - key from the query or the form.
 * @param key - the current access key.
 * @returns true when they are equal.
 */
export function keyMatches(presented: string, key: string): boolean {
  if (key.length === 0) return false
  const expected = Buffer.from(key)
  const actual = Buffer.from(presented)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/**
 * Escape text that goes into the unlock page.
 * @param text - untrusted text.
 * @returns HTML-safe text.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

/**
 * Reject an open redirect: accept only a same-origin absolute path.
 * @param next - untrusted `next` value.
 * @returns a safe path, defaulting to the root.
 */
export function safeNext(next: string | null | undefined): string {
  if (next === null || next === undefined) return '/'
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/'
  return next
}

/** Options for the unlock page. */
export interface UnlockPageOptions {
  /** Authority the browser used, shown so the user knows which node it is. */
  authority: string
  /** Where the form should return to after a successful unlock. */
  next: string
  /** Failure text to show above the field. */
  error?: string
}

/**
 * The page a browser without a cookie receives.
 *
 * Deliberately self-contained: it is served before any harness asset, over a
 * plain-HTTP mesh listener, so it carries its own styles and asks for nothing.
 *
 * @param options - authority, target path and failure text.
 * @returns a complete HTML document.
 */
export function unlockPage(options: UnlockPageOptions): string {
  const error = options.error === undefined ? '' : `<p class="error">${escapeHtml(options.error)}</p>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Remote Access</title>
<style>
  :root{color-scheme:light dark;--bg:#f6f7f8;--card:#fff;--text:#1b1d20;--muted:#61666b;--line:#dfe2e6;--accent:#2b6ef2;--error:#c0362c}
  @media (prefers-color-scheme:dark){:root{--bg:#16181b;--card:#1e2125;--text:#eceef1;--muted:#9aa1a9;--line:#2f3439;--accent:#6f9bff;--error:#ff8a7e}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased;padding:24px}
  .card{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;box-shadow:0 12px 40px rgba(0,0,0,.08)}
  h1{font-size:18px;font-weight:600;margin:0 0 6px}
  p{margin:0 0 18px;color:var(--muted);font-size:13px}
  .authority{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text);font-size:12px;word-break:break-all}
  label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}
  input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:transparent;color:var(--text);font:inherit}
  input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
  button{width:100%;margin-top:14px;padding:10px 12px;border:0;border-radius:9px;background:var(--accent);color:#fff;font:inherit;font-weight:500;cursor:pointer}
  button:hover{opacity:.92}
  .error{color:var(--error);font-size:13px;margin:0 0 14px}
  .hint{margin:16px 0 0;font-size:12px;color:var(--muted)}
</style>
</head>
<body>
  <main class="card">
    <h1>Remote Access</h1>
    <p>This node is reachable over your private network. Enter its access key to continue to <span class="authority">${escapeHtml(options.authority)}</span>.</p>
    ${error}
    <form method="post" action="/__remote/unlock">
      <label for="key">Access key</label>
      <input id="key" name="key" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" required autofocus>
      <input type="hidden" name="next" value="${escapeHtml(options.next)}">
      <button type="submit">Unlock</button>
    </form>
    <p class="hint">The key is shown in the Remote Access panel on the host machine. This cookie lasts 30 days.</p>
  </main>
</body>
</html>`
}

/** One client's recent failures. */
interface Failures {
  count: number
  since: number
}

/**
 * Counts failures per client address so a leaked address cannot be brute-forced.
 *
 * A tailnet is not a trust boundary, so guessing is cheap if it is unlimited.
 * The table is bounded by live clients and self-expires.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, Failures>()

  /**
   * @param limit - failures allowed per window.
   * @param windowMs - window length.
   * @param now - clock; injectable.
   */
  constructor(
    private readonly limit: number = FAILURE_LIMIT,
    private readonly windowMs: number = FAILURE_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Whether this client must wait before another attempt.
   * @param client - remote address.
   * @returns true when the budget is spent.
   */
  isBlocked(client: string): boolean {
    const entry = this.failures.get(client)
    if (entry === undefined) return false
    if (this.now() - entry.since >= this.windowMs) {
      this.failures.delete(client)
      return false
    }
    return entry.count >= this.limit
  }

  /**
   * Record one failure.
   * @param client - remote address.
   */
  recordFailure(client: string): void {
    const entry = this.failures.get(client)
    if (entry === undefined || this.now() - entry.since >= this.windowMs) {
      this.failures.set(client, { count: 1, since: this.now() })
      return
    }
    entry.count += 1
  }

  /** Forget one client, after a success. */
  clear(client: string): void {
    this.failures.delete(client)
  }

  /** Drop expired entries so a long-lived host does not accumulate them. */
  sweep(): void {
    for (const [client, entry] of this.failures) {
      if (this.now() - entry.since >= this.windowMs) this.failures.delete(client)
    }
  }
}