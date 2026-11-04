// @vitest-environment jsdom

/**
 * The panel as a real React tree in a real DOM.
 *
 * This is not a visual check — no pixel is inspected. It proves the shipped
 * component mounts, resolves its two host calls, masks the key until asked,
 * and sends a settings change to the route the host actually serves.
 *
 * The file lives outside `test/` because it imports a `.tsx` module and the
 * host tsconfig has no JSX setting; vitest compiles it with the automatic
 * runtime (see `vitest.config.ts`).
 *
 * @module dsh-remote-access/test-ui/panel
 */

import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Panel } from '../src/client/Panel.tsx'
import { en, type PanelTranslate } from '../src/client/locales.ts'
import { VERSION, type MeshConfigResult, type MeshKeyPayload, type MeshStatus } from '../src/protocol.ts'

const KEY = 'test-key'

const STATUS: MeshStatus = {
  id: 'dsh-remote-access',
  version: '0.1.0',
  enabled: false,
  bound: false,
  address: '100.64.0.1',
  bindHost: 'auto',
  port: 3080,
  scheme: 'http',
  urls: ['http://100.64.0.1:3080/'],
  keyRequired: true,
  hasKey: true,
  upstreamPort: 65202,
  mesh: { kind: 'mesh', interface: 'utun4', address: '100.64.0.1', dnsName: 'node.tail.ts.net' },
}

const KEY_PAYLOAD: MeshKeyPayload = {
  key: KEY,
  urls: [`http://100.64.0.1:3080/?key=${KEY}`],
}

/** Translate with the `{name}` interpolation the locale service performs. */
const t: PanelTranslate = (key, params) =>
  String(en[key]).replace(/\{(\w+)\}/gu, (match, name: string) => String(params?.[name] ?? match))

/** Answer one fetch with JSON. */
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

let container: HTMLDivElement
let root: Root
let fetchCalls: Array<{ url: string; init?: RequestInit }>

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  fetchCalls = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    fetchCalls.push({ url, init })
    if (url.includes('/key')) return json(KEY_PAYLOAD)
    if (init?.method === 'POST') {
      const result: MeshConfigResult = { status: { ...STATUS, enabled: true, bound: true }, saved: true }
      return json(result)
    }
    return json(STATUS)
  })
})

afterEach(() => {
  root.unmount()
  container.remove()
  vi.unstubAllGlobals()
})

/** Let the mount effects and the mocked fetches settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('the Remote Access panel', () => {
  it('mounts, loads both host calls, and shows the credit chip', async () => {
    root.render(<Panel t={t} />)
    await settle()
    expect(fetchCalls.map((call) => call.url)).toEqual([
      'api/dsh-remote-access/status',
      'api/dsh-remote-access/key',
    ])
    expect(container.textContent).toContain('Remote Access')
    expect(container.textContent).toContain(`v${VERSION} | Author: icrefin [icrefinai@gmail.com]`)
    expect(container.textContent).toContain('node.tail.ts.net')
  })

  it('masks the key until the eye button is pressed', async () => {
    root.render(<Panel t={t} />)
    await settle()
    const field = container.querySelector<HTMLInputElement>('.dra-inputSecret')
    expect(field).not.toBeNull()
    expect(field?.value).toBe('http://100.64.0.1:3080/?key=••••••••')
    const eye = container.querySelector<HTMLButtonElement>('.dra-eye')
    expect(eye?.getAttribute('aria-label')).toBe('Show key')
    eye?.click()
    await settle()
    expect(container.querySelector<HTMLInputElement>('.dra-inputSecret')?.value).toContain(`key=${KEY}`)
  })

  it('shows plain links and no key controls when the key is off', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/key')) return json({ key: '', urls: ['http://100.64.0.1:3080/'] })
      return json({ ...STATUS, keyRequired: false })
    })
    root.render(<Panel t={t} />)
    await settle()
    expect(container.querySelector('.dra-eye')).toBeNull()
    expect(container.querySelector<HTMLInputElement>('.dra-inputSecret')).toBeNull()
    expect(container.textContent).toContain('No access key is required')
    const link = [...container.querySelectorAll<HTMLInputElement>('input')].find((field) => field.value === 'http://100.64.0.1:3080/')
    expect(link).toBeDefined()
    expect(container.textContent).not.toContain('Replace key')
  })

  it('sends an enable request to the config route', async () => {
    root.render(<Panel t={t} />)
    await settle()
    const enable = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Enable mesh access'),
    )
    expect(enable).toBeDefined()
    enable?.click()
    await settle()
    const config = fetchCalls.find((call) => call.url === 'api/dsh-remote-access/config')
    expect(config?.init?.method).toBe('POST')
    expect(JSON.parse(String(config?.init?.body))).toEqual({ enabled: true })
    expect(container.textContent).toContain('Listening')
  })

  it('explains a missing mesh interface instead of failing silently', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) =>
      String(input).includes('/key')
        ? json({ key: KEY, urls: [] })
        : json({ ...STATUS, enabled: true, bound: false, address: '', urls: [], mesh: { kind: 'none' }, error: 'no private mesh interface is available' }),
    )
    root.render(<Panel t={t} />)
    await settle()
    expect(container.textContent).toContain('No mesh interface is available')
    expect(container.textContent).toContain('no private mesh interface is available')
  })
})