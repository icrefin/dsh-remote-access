/**
 * Finding the private network this host should serve.
 *
 * A harness web server refuses a wildcard bind on purpose, so this plugin
 * binds one concrete address. That address should be the overlay network's:
 * binding the Wi-Fi address would expose the GUI to whatever café the laptop
 * is sitting in. Tailscale hands every node an address in `100.64.0.0/10`
 * (carrier-grade NAT), and ZeroTier and NetBird reuse that range, so the range
 * is the reliable hint that an interface belongs to a private mesh — the
 * interface name only refines the guess.
 *
 * Everything here is a pure function over injected facts, so the classifier is
 * testable without a real network.
 *
 * @module dsh-remote-access/mesh/detect
 */

import { execFile } from 'node:child_process'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

/** One interface address the listener may bind. */
export interface MeshCandidate {
  /** IPv4 literal. */
  address: string
  /** Interface name, for example `utun4`. */
  iface: string
  /** `mesh` for the CGNAT range, `lan` for RFC1918 addresses. */
  kind: 'mesh' | 'lan'
  /** Higher binds first. */
  score: number
}

/** What the Tailscale CLI reports, when it is installed and running. */
export interface TailscaleState {
  /** Short host name. */
  nodeName?: string
  /** MagicDNS name without its trailing dot. */
  dnsName?: string
  /** Tailnet domain, derived from the MagicDNS name. */
  tailnet?: string
  /** Whether this node is online. */
  online?: boolean
  /** Every address Tailscale reports for this node. */
  ips: string[]
}

/** Interface names that carry an overlay network. */
const OVERLAY_IFACE = /^(tailscale|utun|wg\d|zt|feth|netbird|nwg)/u

/** Interface names that are virtual bridges, containers, or link layer noise. */
const VIRTUAL_IFACE = /^(lo\d*|gif\d*|stf\d*|anpi\d*|ap\d*|awdl\d*|llw\d*|bridge\d*|vmenet\d*|vmnet\d*|docker\d*|veth\d*|tap\d*|tun\d+)$/u

/**
 * Parse a dotted-quad IPv4 address.
 * @param address - candidate text.
 * @returns four octets, or undefined when the text is not IPv4.
 */
export function parseIPv4(address: string): [number, number, number, number] | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return undefined
    const value = Number(part)
    if (value > 255) return undefined
    octets.push(value)
  }
  const [a, b, c, d] = octets as [number, number, number, number]
  return [a, b, c, d]
}

/**
 * Whether an address belongs to `100.64.0.0/10`, the range Tailscale uses.
 * @param address - an IPv4 literal.
 * @returns true for a CGNAT address.
 */
export function isCgnatIPv4(address: string): boolean {
  const parsed = parseIPv4(address)
  if (parsed === undefined) return false
  const [a, b] = parsed
  return a === 100 && b >= 64 && b <= 127
}

/**
 * Whether an address is RFC1918 private space.
 * @param address - an IPv4 literal.
 * @returns true for `10/8`, `172.16/12`, or `192.168/16`.
 */
export function isPrivateIPv4(address: string): boolean {
  const parsed = parseIPv4(address)
  if (parsed === undefined) return false
  const [a, b] = parsed
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return a === 192 && b === 168
}

/**
 * Whether an address is link-local, which no client can dial usefully.
 * @param address - an IPv4 literal.
 * @returns true for `169.254.0.0/16`.
 */
export function isLinkLocalIPv4(address: string): boolean {
  const parsed = parseIPv4(address)
  return parsed !== undefined && parsed[0] === 169 && parsed[1] === 254
}

/**
 * Classify one interface address.
 * @param address - IPv4 literal.
 * @param iface - interface name.
 * @returns the candidate, or undefined when the address is unusable.
 */
export function classifyAddress(address: string, iface: string): MeshCandidate | undefined {
  if (isLinkLocalIPv4(address)) return undefined
  const mesh = isCgnatIPv4(address)
  const lan = isPrivateIPv4(address)
  if (!mesh && !lan) return undefined
  let score = mesh ? 30 : 10
  if (OVERLAY_IFACE.test(iface)) score += 40
  if (VIRTUAL_IFACE.test(iface) && !OVERLAY_IFACE.test(iface)) return undefined
  return { address, iface, kind: mesh ? 'mesh' : 'lan', score }
}

/**
 * Every address a listener could bind, best first.
 * @param interfaces - result of `os.networkInterfaces()`; injectable for tests.
 * @returns candidates ordered by score, then address.
 */
export function listCandidates(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): MeshCandidate[] {
  const found: MeshCandidate[] = []
  for (const [iface, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      const family = String(entry.family)
      if (family !== 'IPv4' && family !== '4') continue
      const candidate = classifyAddress(entry.address, iface)
      if (candidate !== undefined) found.push(candidate)
    }
  }
  return found.sort((left, right) => right.score - left.score || left.address.localeCompare(right.address))
}

/**
 * Every IPv4 literal configured on a local interface, internal or not.
 *
 * Used to reject a hand-typed address that does not belong to this machine
 * before the bind produces `EADDRNOTAVAIL`.
 *
 * @param interfaces - result of `os.networkInterfaces()`; injectable for tests.
 * @returns the addresses, in interface order.
 */
export function localIPv4Addresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  const found: string[] = []
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const family = String(entry.family)
      if (family !== 'IPv4' && family !== '4') continue
      found.push(entry.address)
    }
  }
  return found
}

/**
 * Choose the candidate the listener should bind.
 *
 * An address Tailscale reports as its own wins over the range heuristic, because
 * another overlay network may also use `100.64.0.0/10`.
 *
 * @param candidates - result of {@link listCandidates}.
 * @param tailscale - last known Tailscale state, when available.
 * @returns the chosen candidate, or undefined when the host has no usable one.
 */
export function pickCandidate(
  candidates: readonly MeshCandidate[],
  tailscale?: TailscaleState,
): MeshCandidate | undefined {
  if (candidates.length === 0) return undefined
  const reported = new Set(tailscale?.ips ?? [])
  const owned = candidates.find((candidate) => reported.has(candidate.address))
  return owned ?? candidates[0]
}

/** Runs one command and returns stdout; injectable so tests never exec. */
export type Runner = (command: string, args: readonly string[]) => Promise<string>

/**
 * Where the Tailscale CLI usually lives.
 *
 * A GUI application launched from Finder inherits a minimal `PATH`
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), so a bare `tailscale` is not on it even
 * though the user's shell finds it. The absolute candidates keep the MagicDNS
 * name available in the desktop process, which is the one that matters.
 */
const TAILSCALE_BINARIES: readonly string[] = [
  'tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
]

/**
 * Run a command, resolving its stdout.
 * @param command - executable name.
 * @param args - arguments.
 * @returns stdout.
 */
const runCommand: Runner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: 2_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })

/**
 * Read the node facts out of `tailscale status --json`.
 * @param json - command output.
 * @returns the state, or undefined when the payload has no self node.
 */
export function parseTailscaleStatus(json: string): TailscaleState | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const self = (parsed as { Self?: unknown }).Self
  if (typeof self !== 'object' || self === null) return undefined
  const node = self as {
    DNSName?: unknown
    HostName?: unknown
    TailscaleIPs?: unknown
    Online?: unknown
  }
  const dnsName = typeof node.DNSName === 'string' ? node.DNSName.replace(/\.$/u, '') : undefined
  const dot = dnsName?.indexOf('.') ?? -1
  const tailnet = dnsName !== undefined && dot > 0 ? dnsName.slice(dot + 1) : undefined
  const ips = Array.isArray(node.TailscaleIPs)
    ? node.TailscaleIPs.filter((entry): entry is string => typeof entry === 'string')
    : []
  const state: TailscaleState = { ips }
  if (typeof node.HostName === 'string' && node.HostName.length > 0) state.nodeName = node.HostName
  if (dnsName !== undefined && dnsName.length > 0) state.dnsName = dnsName
  if (tailnet !== undefined && tailnet.length > 0) state.tailnet = tailnet
  if (typeof node.Online === 'boolean') state.online = node.Online
  return state
}

/**
 * Cached reader of the Tailscale CLI.
 *
 * A status read shells out, so it is cached and never awaited on the bind path:
 * the listener falls back to the range heuristic when the CLI is missing, which
 * is the normal case for a Tailscale GUI install without the CLI symlinked.
 */
export class TailscaleProbe {
  private cached: TailscaleState | undefined
  private readAt = 0
  private reading: Promise<TailscaleState | undefined> | undefined

  /**
   * @param run - command runner; injectable.
   * @param ttlMs - how long one result stays fresh.
   * @param now - clock; injectable.
   */
  constructor(
    private readonly run: Runner = runCommand,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The last known state, without waiting. */
  get current(): TailscaleState | undefined {
    return this.cached
  }

  /**
   * Read the state, refreshing at most once per TTL.
   * @returns the state, or undefined when the CLI is unavailable.
   */
  async read(): Promise<TailscaleState | undefined> {
    if (this.now() - this.readAt < this.ttlMs) return this.cached
    this.reading ??= this.refresh()
    return this.reading
  }

  /**
   * Shell out once and cache the answer.
   * @returns the state, or undefined on any failure.
   */
  private async refresh(): Promise<TailscaleState | undefined> {
    this.cached = undefined
    try {
      for (const binary of TAILSCALE_BINARIES) {
        try {
          const stdout = await this.run(binary, ['status', '--json'])
          this.cached = parseTailscaleStatus(stdout)
          if (this.cached !== undefined) break
        } catch {
          // Try the next location; a missing binary is the normal case.
        }
      }
    } finally {
      this.readAt = this.now()
      this.reading = undefined
    }
    return this.cached
  }
}