import type { BrowserTab } from '../types.js'
import type { PageAdapter } from './adapter.js'

interface CdpTargetInfo {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

interface CdpResponse {
  id?: number
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

interface PendingCall {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface CdpWebSocket {
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: Event & { data?: unknown }) => void): void
  send(data: string): void
  close(): void
}

type WebSocketFactory = (url: string) => CdpWebSocket

class CdpConnection {
  private readonly socket: CdpWebSocket
  private nextId = 1
  private readonly pending = new Map<number, PendingCall>()
  private readonly opened: Promise<void>

  constructor(url: string, private readonly timeoutMs = 15_000, socketFactory: WebSocketFactory = (target) => new WebSocket(target) as unknown as CdpWebSocket) {
    this.socket = socketFactory(url)
    this.opened = new Promise<void>((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve())
      this.socket.addEventListener('message', (event) => this.onMessage(String(event.data ?? '')))
      this.socket.addEventListener('error', () => reject(new Error(`CDP WebSocket error: ${url}`)))
      this.socket.addEventListener('close', () => this.rejectPending(new Error('CDP WebSocket closed')))
    })
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.opened
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP call timed out: ${method}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    this.rejectPending(new Error('CDP connection closed'))
    this.socket.close()
  }

  private onMessage(raw: string): void {
    let message: CdpResponse
    try { message = JSON.parse(raw) as CdpResponse } catch { return }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(`CDP error ${message.error.code}: ${message.error.message}`))
    else pending.resolve(message.result ?? {})
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of Array.from(this.pending.entries())) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}

export interface CdpBrowserAdapterOptions {
  endpoint?: string
  timeoutMs?: number
  searchUrl?: string
  fetcher?: typeof fetch
  socketFactory?: WebSocketFactory
}

/**
 * Real browser host adapter for Chromium/Electron targets exposing the Chrome
 * DevTools Protocol. The core stays Electron-free; hosts can also provide their
 * own PageAdapter implementation.
 */
export class CdpBrowserAdapter implements PageAdapter {
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly searchUrl: string
  private readonly fetcher: typeof fetch
  private readonly socketFactory?: WebSocketFactory
  private targets = new Map<string, CdpTargetInfo>()
  private connections = new Map<string, CdpConnection>()
  private activeId?: string

  constructor(options: CdpBrowserAdapterOptions = {}) {
    this.endpoint = (options.endpoint ?? 'http://127.0.0.1:9222').replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.searchUrl = options.searchUrl ?? 'https://www.google.com/search?q='
    this.fetcher = options.fetcher ?? fetch
    this.socketFactory = options.socketFactory
  }

  async refresh(): Promise<BrowserTab[]> {
    const response = await this.fetcher(`${this.endpoint}/json/list`)
    if (!response.ok) throw new Error(`CDP target list failed with HTTP ${response.status}`)
    const raw: unknown = await response.json()
    if (!Array.isArray(raw)) throw new Error('CDP target list was not an array')
    this.targets = new Map(raw.filter(isPageTarget).map((target) => [target.id, target]))
    if (!this.activeId || !this.targets.has(this.activeId)) this.activeId = this.targets.keys().next().value
    for (const id of Array.from(this.connections.keys())) {
      if (!this.targets.has(id)) {
        this.connections.get(id)?.close()
        this.connections.delete(id)
      }
    }
    return this.toTabs()
  }

  async snapshot(): Promise<string> {
    const value = await this.evaluate(`(() => {
      const text = document.body?.innerText || '';
      const controls = Array.from(document.querySelectorAll('button,a,input,textarea,select,[role="button"],[role="link"]')).slice(0, 100).map((el, index) => ({
        index,
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        name: el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '',
        type: el.getAttribute('type') || undefined,
      }));
      return JSON.stringify({ title: document.title, url: location.href, text: text.slice(0, 30000), controls });
    })()`)
    return typeof value === 'string' ? value : JSON.stringify(value ?? {})
  }

  async readPage(): Promise<string> { return String(await this.evaluate('document.body?.innerText || ""')) }

  async extractArticle(): Promise<string> {
    return String(await this.evaluate('document.querySelector("article,main")?.innerText || document.body?.innerText || ""'))
  }

  async getSelection(): Promise<string> { return String(await this.evaluate('window.getSelection()?.toString() || ""')) }

  async getCurrentUrl(): Promise<string> { return String(await this.evaluate('location.href')) }

  async getPageTitle(): Promise<string> { return String(await this.evaluate('document.title')) }

  async getActiveTab(): Promise<BrowserTab | undefined> {
    await this.refresh()
    const target = this.activeId ? this.targets.get(this.activeId) : undefined
    return target ? this.toTab(target, true) : undefined
  }

  async listTabs(): Promise<BrowserTab[]> { return this.refresh() }

  async selectTab(id: string): Promise<boolean> {
    await this.refresh()
    if (!this.targets.has(id)) return false
    this.activeId = id
    return true
  }

  async openTab(url: string): Promise<BrowserTab> {
    assertHttpUrl(url)
    let response = await this.fetcher(`${this.endpoint}/json/new?${new URLSearchParams({ url })}`, { method: 'PUT' })
    if (!response.ok) response = await this.fetcher(`${this.endpoint}/json/new?${new URLSearchParams({ url })}`, { method: 'POST' })
    if (!response.ok) throw new Error(`CDP could not open tab: HTTP ${response.status}`)
    const raw: unknown = await response.json()
    if (!isPageTarget(raw)) throw new Error('CDP open-tab response was invalid')
    this.targets.set(raw.id, raw)
    this.activeId = raw.id
    return this.toTab(raw, true)
  }

  async closeTab(id: string): Promise<boolean> {
    if (!/^[-\w]+$/.test(id)) return false
    const response = await this.fetcher(`${this.endpoint}/json/close/${encodeURIComponent(id)}`)
    if (!response.ok) return false
    this.connections.get(id)?.close()
    this.connections.delete(id)
    this.targets.delete(id)
    if (this.activeId === id) this.activeId = this.targets.keys().next().value
    return true
  }

  async click(selector: string): Promise<{ ok: boolean; error?: string }> {
    return this.action(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { ok: false, error: 'Selector not found' }; el.click(); return { ok: true }; })()`)
  }

  async type(selector: string, value: string): Promise<{ ok: boolean; error?: string }> {
    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Selector not found' };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) return { ok: false, error: 'Element is not a text input' };
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()`
    return this.action(script)
  }

  async submitForm(selector: string): Promise<{ ok: boolean; error?: string }> {
    return this.action(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { ok: false, error: 'Selector not found' }; if (el.requestSubmit) el.requestSubmit(); else el.submit(); return { ok: true }; })()`)
  }

  async scroll(amount: number): Promise<{ ok: boolean; error?: string }> {
    return this.action(`(() => { window.scrollBy(0, ${Math.trunc(amount)}); return { ok: true }; })()`)
  }

  async navigate(url: string): Promise<{ ok: boolean; error?: string }> {
    try { assertHttpUrl(url) } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    try { await this.call('Page.navigate', { url }); return { ok: true } } catch (error) { return { ok: false, error: messageOf(error) } }
  }

  async back(): Promise<{ ok: boolean; error?: string }> { return this.historyMove(-1) }

  async forward(): Promise<{ ok: boolean; error?: string }> { return this.historyMove(1) }

  async reload(): Promise<{ ok: boolean; error?: string }> {
    try { await this.call('Page.reload', { ignoreCache: false }); return { ok: true } } catch (error) { return { ok: false, error: messageOf(error) } }
  }

  async search(query: string): Promise<{ ok: boolean; error?: string }> {
    return this.navigate(`${this.searchUrl}${encodeURIComponent(query)}`)
  }

  async savePage(): Promise<{ ok: boolean; error?: string }> {
    try { await this.call('Page.captureSnapshot', { format: 'mhtml' }); return { ok: true } } catch (error) { return { ok: false, error: messageOf(error) } }
  }

  async startReader(): Promise<{ ok: boolean; error?: string }> { return { ok: false, error: 'Reader mode is host-specific' } }

  async startTts(): Promise<{ ok: boolean; error?: string }> { return { ok: false, error: 'Text-to-speech is host-specific' } }

  async download(url?: string): Promise<{ ok: boolean; error?: string }> {
    if (!url) return { ok: false, error: 'A download URL is required' }
    return this.navigate(url)
  }

  async upload(_selector: string, _path: string): Promise<{ ok: boolean; error?: string }> { return { ok: false, error: 'File upload requires a host-specific file chooser bridge' } }

  async deleteSavedPage(_id: string): Promise<{ ok: boolean; error?: string }> { return { ok: false, error: 'Saved-page storage is host-specific' } }

  async changePrivacySetting(_enabled: boolean): Promise<{ ok: boolean; error?: string }> { return { ok: false, error: 'Privacy controls are host-specific' } }

  async getPrivacyStats(): Promise<unknown> { return { supported: false, reason: 'Privacy controls are host-specific' } }

  close(): void {
    for (const connection of Array.from(this.connections.values())) connection.close()
    this.connections.clear()
  }

  private async action(script: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const raw = await this.evaluate(script)
      if (!isActionResult(raw)) return { ok: false, error: 'Browser action returned an invalid result' }
      return raw
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  private async historyMove(delta: -1 | 1): Promise<{ ok: boolean; error?: string }> {
    try {
      const history = await this.call('Page.getNavigationHistory')
      const entries = Array.isArray(history.entries) ? history.entries : []
      const currentIndex = typeof history.currentIndex === 'number' ? history.currentIndex : -1
      const next = entries[currentIndex + delta]
      if (!isRecord(next) || typeof next.id !== 'number') return { ok: false, error: 'No history entry in that direction' }
      await this.call('Page.navigateToHistoryEntry', { entryId: next.id })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  private async evaluate(expression: string): Promise<unknown> {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    const remote = isRecord(result.result) ? result.result : undefined
    if (remote && 'value' in remote) return remote.value
    if (remote && typeof remote.description === 'string') return remote.description
    return undefined
  }

  private async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const target = await this.activeTarget()
    const connection = this.connectionFor(target)
    return connection.call(method, params)
  }

  private async activeTarget(): Promise<CdpTargetInfo> {
    await this.refresh()
    const target = this.activeId ? this.targets.get(this.activeId) : undefined
    if (!target?.webSocketDebuggerUrl) throw new Error('No debuggable page target is available')
    return target
  }

  private connectionFor(target: CdpTargetInfo): CdpConnection {
    const existing = this.connections.get(target.id)
    if (existing) return existing
    const connection = new CdpConnection(target.webSocketDebuggerUrl!, this.timeoutMs, this.socketFactory)
    this.connections.set(target.id, connection)
    void connection.call('Page.enable').catch(() => undefined)
    void connection.call('Runtime.enable').catch(() => undefined)
    return connection
  }

  private toTabs(): BrowserTab[] {
    return Array.from(this.targets.values()).map((target) => this.toTab(target, target.id === this.activeId))
  }

  private toTab(target: CdpTargetInfo, active: boolean): BrowserTab {
    return { id: target.id, url: target.url, title: target.title || target.url, active }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }

function isPageTarget(value: unknown): value is CdpTargetInfo {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && value.type === 'page' && typeof value.title === 'string' && typeof value.url === 'string'
}

function isActionResult(value: unknown): value is { ok: boolean; error?: string } {
  return isRecord(value) && typeof value.ok === 'boolean' && (value.error === undefined || typeof value.error === 'string')
}

function assertHttpUrl(url: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http/https URLs are allowed')
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export { CdpConnection, type CdpTargetInfo, type WebSocketFactory }
