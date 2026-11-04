/**
 * The access key, and where it lives.
 *
 * The harness already authenticates its own browser sessions with a launch
 * token and a signed cookie. This gateway answers to browsers that have no
 * tokens at all — a phone on the tailnet — so it needs a credential of its own,
 * and it must be one a person can type. The key is therefore minted here, kept
 * in one file under `$DSH_HOME`, and read on every use: a host that has to be
 * restarted before it notices a rotated key is a host that reports the old key
 * as correct.
 *
 * @module dsh-remote-access/mesh/secret
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Words in a typed key: enough entropy for 128 bits of security. */
const KEY_BYTES = 32

/**
 * The harness home this plugin keeps its key in.
 * @returns the absolute path.
 */
export function dshHome(): string {
  const home = process.env.DSH_HOME?.trim()
  return home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh')
}

/**
 * The directory holding this plugin's state.
 * @returns the absolute path.
 */
export function meshHome(): string {
  return join(dshHome(), 'remote-access')
}

/**
 * The file holding the access key.
 * @returns the absolute path.
 */
export function secretPath(): string {
  return join(meshHome(), 'key')
}

/**
 * Mint a fresh key.
 * @returns 32 random bytes as base64url, safe in a URL query.
 */
export function randomKey(): string {
  return randomBytes(KEY_BYTES).toString('base64url')
}

/**
 * Read the key from disk.
 * @returns the trimmed key, or an empty string when there is none.
 */
export function readKey(): string {
  try {
    return readFileSync(secretPath(), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Write the key with owner-only permissions.
 * @param key - the value to persist.
 * @returns the key.
 */
function writeKey(key: string): string {
  const directory = meshHome()
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(secretPath(), `${key}\n`, { mode: 0o600 })
  return key
}

/**
 * Return the key, minting one on first use.
 * @param mint - key generator; injectable.
 * @returns the existing or freshly minted key.
 */
export function ensureKey(mint: () => string = randomKey): string {
  const existing = readKey()
  if (existing.length > 0) return existing
  return writeKey(mint())
}

/**
 * Replace the key, which invalidates every cookie already issued.
 * @param mint - key generator; injectable.
 * @returns the new key.
 */
export function regenerateKey(mint: () => string = randomKey): string {
  return writeKey(mint())
}