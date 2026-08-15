import { afterEach, describe, expect, it, vi } from 'vitest'
import { CdpBrowserAdapter, CdpConnection, type CdpTargetInfo, type WebSocketFactory } from '../src/host/cdp.js'

interface FakeSocket {
  sent: string[]
  listeners: Map<string, Array<(event: { data?: unknown }) => void>>
  closeCalls: number
}

function createFakeSocket(): FakeSocket {
  return { sent: [], listeners: new Map(), closeCalls: 0 }
}

function fakeSocketFactory(sockets: FakeSocket[]): WebSocketFactory {
  let index = 0
  return (url: string) => {
    const socket = sockets[index++] ?? createFakeSocket()
    sockets.push(socket)
    return {
      addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void): void {
        const list = socket.listeners.get(type) ?? []
        list.push(listener)
        socket.listeners.set(type, list)
      },
      send(data: string): void { socket.sent.push(data) },
      close(): void { socket.closeCalls += 1 },
    } as never
  }
}

function openSocket(socket: FakeSocket): void {
  for (const listener of socket.listeners.get('open') ?? []) listener({})
}

function sendSocketMessage(socket: FakeSocket, message: unknown): void {
  for (const listener of socket.listeners.get('message') ?? []) listener({ data: JSON.stringify(message) })
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function closeSocket(socket: FakeSocket): void {
  for (const listener of socket.listeners.get('close') ?? []) listener({})
}

/** Wait until the adapter has created its real CDP socket, then return it. */
async function waitForSocket(sockets: FakeSocket[]): Promise<FakeSocket> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const socket = sockets.at(-1)
    if (socket) return socket
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Adapter never created a CDP socket')
}

const pageTarget = (id: string, url = 'https://example.com/'): CdpTargetInfo => ({
  id,
  type: 'page',
  title: `Page ${id}`,
  url,
  webSocketDebuggerUrl: `ws://fake/${id}`,
})

const sockets: FakeSocket[] = []
let listResponse: unknown = [pageTarget('tab-1')]
let newTabResponse: unknown = pageTarget('tab-2')
let fetcherCalls: Array<{ url: string; init?: RequestInit }> = []

function makeFetcher(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    fetcherCalls.push({ url, init })
    if (url.includes('/json/list')) {
      return new Response(JSON.stringify(listResponse), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/json/new')) {
      return new Response(JSON.stringify(newTabResponse), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/json/close/')) return new Response('{}', { status: 200 })
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

function createAdapter(): CdpBrowserAdapter {
  sockets.length = 0
  const adapter = new CdpBrowserAdapter({
    endpoint: 'http://127.0.0.1:9222',
    fetcher: makeFetcher(),
    socketFactory: fakeSocketFactory(sockets),
  })
  return adapter
}

afterEach(() => {
  sockets.length = 0
  listResponse = [pageTarget('tab-1')]
  newTabResponse = pageTarget('tab-2')
  fetcherCalls = []
})

describe('CdpConnection', () => {
  it('sends JSON-RPC and resolves the matching response', async () => {
    const socket = createFakeSocket()
    const connection = new CdpConnection('ws://fake', 1_000, fakeSocketFactory([socket]))
    const pending = connection.call('Runtime.evaluate', { expression: '1 + 1' })
    openSocket(socket)
    await flushMicrotasks()
    const sent = socket.sent[0] ?? '{}'
    const request = JSON.parse(sent) as { id: number; method: string }
    expect(request.method).toBe('Runtime.evaluate')
    sendSocketMessage(socket, { id: request.id, result: { result: { type: 'number', value: 2 } } })
    await expect(pending).resolves.toMatchObject({ result: { type: 'number', value: 2 } })
  })

  it('rejects on a CDP error response', async () => {
    const socket = createFakeSocket()
    const connection = new CdpConnection('ws://fake', 1_000, fakeSocketFactory([socket]))
    const pending = connection.call('Page.navigate', {})
    openSocket(socket)
    await flushMicrotasks()
    const request = JSON.parse(socket.sent[0] ?? '{}') as { id: number }
    sendSocketMessage(socket, { id: request.id, error: { code: -32000, message: 'Cannot navigate' } })
    await expect(pending).rejects.toThrow('Cannot navigate')
  })

  it('times out CDP calls and rejects', async () => {
    vi.useFakeTimers()
    try {
      const socket = createFakeSocket()
      const connection = new CdpConnection('ws://fake', 50, fakeSocketFactory([socket]))
      const pending = connection.call('Page.navigate', {})
      openSocket(socket)
      await flushMicrotasks()
      vi.advanceTimersByTime(100)
      await expect(pending).rejects.toThrow('timed out')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('CdpBrowserAdapter', () => {
  it('lists page targets as opaque tabs with active selection', async () => {
    const adapter = createAdapter()
    const tabs = await adapter.listTabs()
    expect(tabs).toEqual([{ id: 'tab-1', url: 'https://example.com/', title: 'Page tab-1', active: true }])
  })

  it('evaluates DOM scripts over the target WebSocket', async () => {
    const adapter = createAdapter()
    const snapshotPromise = adapter.snapshot()
    const socket = await waitForSocket(sockets)
    openSocket(socket)
    await flushMicrotasks()
    const sentMessages = socket.sent.map((raw) => JSON.parse(raw) as { id: number; method: string })
    const request = sentMessages.find((message) => message.method === 'Runtime.evaluate')
    expect(request).toBeDefined()
    sendSocketMessage(socket, {
      id: request.id,
      result: { result: { type: 'string', value: '{"title":"Page tab-1","url":"https://example.com/","text":"hello","controls":[]}' } },
    })
    const value = await snapshotPromise
    expect(typeof value).toBe('string')
    const parsed = JSON.parse(value as string) as { title: string; text: string }
    expect(parsed.title).toBe('Page tab-1')
    expect(parsed.text).toBe('hello')
  })

  it('returns an ok:false result when an action errors', async () => {
    const adapter = createAdapter()
    const clickPromise = adapter.click('#missing')
    const socket = await waitForSocket(sockets)
    openSocket(socket)
    await flushMicrotasks()
    const sentMessages = socket.sent.map((raw) => JSON.parse(raw) as { id: number; method: string })
    const request = sentMessages.find((message) => message.method === 'Runtime.evaluate')
    expect(request).toBeDefined()
    if (request) sendSocketMessage(socket, { id: request.id, result: { result: { type: 'object', value: { ok: false, error: 'Selector not found' } } } })
    await expect(clickPromise).resolves.toEqual({ ok: false, error: 'Selector not found' })
  })

  it('opens a new tab via the CDP endpoint', async () => {
    const adapter = createAdapter()
    const tab = await adapter.openTab('https://example.org/')
    expect(tab.id).toBe('tab-2')
    expect(fetcherCalls.some((call) => call.url.includes('/json/new'))).toBe(true)
  })

  it('rejects non-http URLs when opening tabs', async () => {
    const adapter = createAdapter()
    await expect(adapter.openTab('javascript:alert(1)')).rejects.toThrow('Only http/https URLs are allowed')
  })

  it('closes a connection and drops targets when the WebSocket closes', async () => {
    const adapter = createAdapter()
    const snapshotPromise = adapter.snapshot()
    const socket = await waitForSocket(sockets)
    openSocket(socket)
    await flushMicrotasks()
    const sentMessages = socket.sent.map((raw) => JSON.parse(raw) as { id: number; method: string })
    const request = sentMessages.find((message) => message.method === 'Runtime.evaluate')
    expect(request).toBeDefined()
    if (request) sendSocketMessage(socket, { id: request.id, result: { result: { type: 'undefined' } } })
    closeSocket(socket)
    await snapshotPromise
    adapter.close()
    expect(socket.closeCalls).toBeGreaterThan(0)
  })

  it('resolves active tab through getActiveTab', async () => {
    const adapter = createAdapter()
    const active = await adapter.getActiveTab()
    expect(active?.id).toBe('tab-1')
    expect(active?.active).toBe(true)
  })

  it('selects a known tab and reports unknown ids as failures', async () => {
    const adapter = createAdapter()
    expect(await adapter.selectTab('tab-1')).toBe(true)
    expect(await adapter.selectTab('ghost')).toBe(false)
  })

  it('closeTab validates the id format before hitting the endpoint', async () => {
    const adapter = createAdapter()
    expect(await adapter.closeTab('bad/id')).toBe(false)
  })

  it('navigates only to http(s) targets', async () => {
    const adapter = createAdapter()
    const navigatePromise = adapter.navigate('https://example.com/next')
    const socket = await waitForSocket(sockets)
    openSocket(socket)
    await flushMicrotasks()
    const sentMessages = socket.sent.map((raw) => JSON.parse(raw) as { id: number; method: string })
    const request = sentMessages.find((message) => message.method === 'Page.navigate')
    expect(request).toBeDefined()
    if (request) sendSocketMessage(socket, { id: request.id, result: {} })
    await expect(navigatePromise).resolves.toEqual({ ok: true })

    await expect(adapter.navigate('file:///etc/passwd')).resolves.toMatchObject({ ok: false })
  })

  it('performs history moves through navigation history', async () => {
    const adapter = createAdapter()
    const backPromise = adapter.back()
    const socket = await waitForSocket(sockets)
    openSocket(socket)
    await flushMicrotasks()
    // The first sent message is the fire-and-forget Page.enable; find the real getNavigationHistory.
    const calls = socket.sent.map((raw) => JSON.parse(raw) as { id: number; method: string })
    const historyCall = calls.filter((call) => call.method === 'Page.getNavigationHistory').at(-1)
    expect(historyCall).toBeDefined()
    sendSocketMessage(socket, {
      id: historyCall!.id,
      result: { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }] },
    })
    await flushMicrotasks()
    // After the history response resolves, back() issues navigateToHistoryEntry; poll for it.
    let navigateCall: { id: number; method: string } | undefined
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = socket.sent.map((raw) => JSON.parse(raw) as { id: number; method: string })
      navigateCall = current.filter((call) => call.method === 'Page.navigateToHistoryEntry').at(-1)
      if (navigateCall) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(navigateCall).toBeDefined()
    if (navigateCall) sendSocketMessage(socket, { id: navigateCall.id, result: {} })
    await expect(backPromise).resolves.toEqual({ ok: true })
  })
})
