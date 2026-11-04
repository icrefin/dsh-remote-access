/**
 * The interface classifier and the Tailscale reader.
 *
 * The regression that matters here: an overlay address is the only safe default
 * bind, so the classifier must never hand back a bridge, a link-local address,
 * or a public one — and it must prefer the address Tailscale itself reports over
 * a lookalike in the same range.
 *
 * @module dsh-remote-access/test/detect
 */

import { describe, expect, it } from 'vitest'
import {
  TailscaleProbe,
  classifyAddress,
  isCgnatIPv4,
  isPrivateIPv4,
  listCandidates,
  localIPv4Addresses,
  parseIPv4,
  parseTailscaleStatus,
  pickCandidate,
} from '../src/mesh/detect.ts'

/** One interface entry as Node reports it. */
function entry(address: string, family: string = 'IPv4', internal = false) {
  return { address, netmask: '255.255.255.0', family, mac: '00:00:00:00:00:00', internal, cidr: null } as never
}

describe('address ranges', () => {
  it('parses only dotted quads', () => {
    expect(parseIPv4('100.64.0.1')).toEqual([100, 64, 0, 1])
    expect(parseIPv4('100.64.0')).toBeUndefined()
    expect(parseIPv4('100.64.0.256')).toBeUndefined()
    expect(parseIPv4('100.64.0.x')).toBeUndefined()
  })

  it('recognises exactly 100.64.0.0/10', () => {
    expect(isCgnatIPv4('100.64.0.1')).toBe(true)
    expect(isCgnatIPv4('100.127.255.255')).toBe(true)
    expect(isCgnatIPv4('100.63.255.255')).toBe(false)
    expect(isCgnatIPv4('100.128.0.0')).toBe(false)
    expect(isCgnatIPv4('192.168.1.2')).toBe(false)
  })

  it('recognises RFC1918 space', () => {
    expect(isPrivateIPv4('10.1.2.3')).toBe(true)
    expect(isPrivateIPv4('172.16.0.1')).toBe(true)
    expect(isPrivateIPv4('172.32.0.1')).toBe(false)
    expect(isPrivateIPv4('192.168.1.1')).toBe(true)
    expect(isPrivateIPv4('8.8.8.8')).toBe(false)
  })
})

describe('classifyAddress', () => {
  it('rejects what no client can dial usefully', () => {
    expect(classifyAddress('169.254.1.1', 'en0')).toBeUndefined()
    expect(classifyAddress('8.8.8.8', 'en0')).toBeUndefined()
    expect(classifyAddress('192.168.1.5', 'bridge0')).toBeUndefined()
    expect(classifyAddress('192.168.1.5', 'vmenet0')).toBeUndefined()
  })

  it('scores an overlay address above a Wi-Fi address', () => {
    const mesh = classifyAddress('100.64.0.7', 'utun4')
    const lan = classifyAddress('192.168.1.20', 'en0')
    expect(mesh?.kind).toBe('mesh')
    expect(lan?.kind).toBe('lan')
    expect(mesh?.score).toBeGreaterThan(lan?.score ?? 0)
  })
})

describe('listCandidates', () => {
  it('keeps only usable IPv4 addresses, best first', () => {
    const candidates = listCandidates({
      lo0: [entry('127.0.0.1', 'IPv4', true)],
      en0: [entry('192.168.1.20')],
      utun4: [entry('100.64.0.7')],
      awdl0: [entry('fe80::1', 'IPv6')],
      bridge100: [entry('192.168.139.3')],
    })
    expect(candidates.map((candidate) => candidate.address)).toEqual(['100.64.0.7', '192.168.1.20'])
  })

  it('survives an interface with no addresses', () => {
    expect(listCandidates({ en5: [] })).toEqual([])
  })

  it('lists every local address for validating a typed bind', () => {
    const addresses = localIPv4Addresses({
      lo0: [entry('127.0.0.1', 'IPv4', true)],
      en0: [entry('192.168.1.20')],
    })
    expect(addresses).toEqual(['127.0.0.1', '192.168.1.20'])
  })
})

describe('pickCandidate', () => {
  const candidates = [
    { address: '100.90.1.2', iface: 'utun3', kind: 'mesh' as const, score: 85 },
    { address: '100.64.0.7', iface: 'utun4', kind: 'mesh' as const, score: 70 },
  ]

  it('prefers the address Tailscale reports as its own', () => {
    expect(pickCandidate(candidates, { ips: ['100.64.0.7'] })?.address).toBe('100.64.0.7')
  })

  it('falls back to the best-scoring candidate', () => {
    expect(pickCandidate(candidates, undefined)?.address).toBe('100.90.1.2')
    expect(pickCandidate([], undefined)).toBeUndefined()
  })
})

describe('parseTailscaleStatus', () => {
  const payload = JSON.stringify({
    Self: {
      HostName: 'studio',
      DNSName: 'studio.tail1234.ts.net.',
      TailscaleIPs: ['100.64.0.7', 'fd7a:115c:a1e0::1'],
      Online: true,
    },
  })

  it('reads the node name, MagicDNS name and tailnet', () => {
    expect(parseTailscaleStatus(payload)).toEqual({
      nodeName: 'studio',
      dnsName: 'studio.tail1234.ts.net',
      tailnet: 'tail1234.ts.net',
      online: true,
      ips: ['100.64.0.7', 'fd7a:115c:a1e0::1'],
    })
  })

  it('reports nothing for junk instead of throwing', () => {
    expect(parseTailscaleStatus('not json')).toBeUndefined()
    expect(parseTailscaleStatus('{"Self":null}')).toBeUndefined()
    expect(parseTailscaleStatus('{"ExitNodeStatus":{}}')).toBeUndefined()
  })
})

describe('TailscaleProbe', () => {
  it('caches one shell-out across reads', async () => {
    let calls = 0
    const probe = new TailscaleProbe(async () => {
      calls += 1
      return JSON.stringify({ Self: { HostName: 'n', DNSName: 'n.t.ts.net.', TailscaleIPs: ['100.1.2.3'] } })
    }, 60_000)
    await probe.read()
    await probe.read()
    expect(calls).toBe(1)
    expect(probe.current?.nodeName).toBe('n')
  })

  it('reports absence when the CLI is missing', async () => {
    const probe = new TailscaleProbe(async () => {
      throw new Error('ENOENT')
    })
    await expect(probe.read()).resolves.toBeUndefined()
    expect(probe.current).toBeUndefined()
  })
})