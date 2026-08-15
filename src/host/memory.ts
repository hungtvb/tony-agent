import type { BrowserTab } from '../types.js'
import type { PageAdapter } from './adapter.js'

export interface MemoryPageFixture {
  url: string
  title: string
  text: string
  selection?: string
  article?: string
  controls?: Record<string, string>
}

interface MemoryPage extends MemoryPageFixture {
  id: string
  scrollY: number
  inputValues: Record<string, string>
}

function cloneTab(page: MemoryPage, active: boolean): BrowserTab {
  return { id: page.id, url: page.url, title: page.title, active }
}

/** In-memory browser host used by tests and the offline demo. */
export class MemoryPageAdapter implements PageAdapter {
  private readonly pages: MemoryPage[] = []
  private activeIndex = 0
  private nextId = 1
  private saved = false
  private privacyEnabled = true

  constructor(fixture: MemoryPageFixture) {
    this.pages.push(this.createPage(fixture))
  }

  async snapshot(): Promise<string> {
    const page = this.activePage()
    const controls = Object.entries(page.controls ?? {})
      .map(([selector, label]) => `${selector}: ${label}`)
      .join('\n')
    const inputs = Object.entries(page.inputValues)
      .map(([selector, value]) => `${selector}=${value}`)
      .join('\n')
    return [
      `TITLE: ${page.title}`,
      `URL: ${page.url}`,
      `SCROLL_Y: ${page.scrollY}`,
      `TEXT:\n${page.text}`,
      controls ? `CONTROLS:\n${controls}` : '',
      inputs ? `INPUTS:\n${inputs}` : '',
    ].filter(Boolean).join('\n\n')
  }

  async readPage(): Promise<string> { return this.activePage().text }

  async extractArticle(): Promise<string> { return this.activePage().article ?? this.activePage().text }

  async getSelection(): Promise<string> { return this.activePage().selection ?? '' }

  async getCurrentUrl(): Promise<string> { return this.activePage().url }

  async getPageTitle(): Promise<string> { return this.activePage().title }

  async getActiveTab(): Promise<BrowserTab | undefined> {
    const page = this.pages[this.activeIndex]
    return page ? cloneTab(page, true) : undefined
  }

  async listTabs(): Promise<BrowserTab[]> {
    return this.pages.map((page, index) => cloneTab(page, index === this.activeIndex))
  }

  async selectTab(id: string): Promise<boolean> {
    const index = this.pages.findIndex((page) => page.id === id)
    if (index < 0) return false
    this.activeIndex = index
    return true
  }

  async openTab(url: string): Promise<BrowserTab> {
    const page = this.createPage({ url, title: 'New tab', text: '' })
    this.pages.push(page)
    this.activeIndex = this.pages.length - 1
    return cloneTab(page, true)
  }

  async closeTab(id: string): Promise<boolean> {
    const index = this.pages.findIndex((page) => page.id === id)
    if (index < 0) return false
    this.pages.splice(index, 1)
    if (this.pages.length === 0) {
      this.pages.push(this.createPage({ url: 'about:blank', title: 'New tab', text: '' }))
      this.activeIndex = 0
    } else if (this.activeIndex >= this.pages.length) {
      this.activeIndex = this.pages.length - 1
    } else if (index < this.activeIndex) {
      this.activeIndex -= 1
    }
    return true
  }

  async click(selector: string): Promise<{ ok: boolean; error?: string }> {
    return this.hasControl(selector) ? { ok: true } : { ok: false, error: `Could not find control: ${selector}` }
  }

  async type(selector: string, value: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.hasControl(selector)) return { ok: false, error: `Could not find control: ${selector}` }
    this.activePage().inputValues[selector] = value
    return { ok: true }
  }

  async submitForm(selector: string): Promise<{ ok: boolean; error?: string }> {
    return this.click(selector)
  }

  async scroll(amount: number): Promise<{ ok: boolean; error?: string }> {
    this.activePage().scrollY += Math.trunc(amount)
    return { ok: true }
  }

  async navigate(url: string): Promise<{ ok: boolean; error?: string }> {
    try { new URL(url) } catch { return { ok: false, error: 'Only valid URLs are allowed' } }
    this.activePage().url = url
    return { ok: true }
  }

  async back(): Promise<{ ok: boolean; error?: string }> { return { ok: false, error: 'History is not available in memory mode' } }

  async forward(): Promise<{ ok: boolean; error?: string }> { return { ok: false, error: 'History is not available in memory mode' } }

  async reload(): Promise<{ ok: boolean; error?: string }> { return { ok: true } }

  async search(query: string): Promise<{ ok: boolean; error?: string }> {
    this.activePage().text = `Search results for: ${query}`
    return { ok: true }
  }

  async savePage(): Promise<{ ok: boolean; error?: string }> {
    this.saved = true
    return { ok: true }
  }

  async startReader(): Promise<{ ok: boolean; error?: string }> { return { ok: true } }

  async startTts(): Promise<{ ok: boolean; error?: string }> { return { ok: true } }

  async download(url?: string): Promise<{ ok: boolean; error?: string }> {
    return url ? { ok: true } : { ok: false, error: 'A download URL is required' }
  }

  async upload(selector: string, path: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.hasControl(selector)) return { ok: false, error: `Could not find control: ${selector}` }
    return path.length > 0 ? { ok: true } : { ok: false, error: 'An upload path is required' }
  }

  async deleteSavedPage(_id: string): Promise<{ ok: boolean; error?: string }> {
    this.saved = false
    return { ok: true }
  }

  async changePrivacySetting(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    this.privacyEnabled = enabled
    return { ok: true }
  }

  async getPrivacyStats(): Promise<unknown> {
    return { enabled: this.privacyEnabled, saved: this.saved, blocked: 0 }
  }

  private createPage(fixture: MemoryPageFixture): MemoryPage {
    return {
      ...fixture,
      id: `memory-tab-${this.nextId++}`,
      controls: { ...(fixture.controls ?? {}) },
      inputValues: {},
      scrollY: 0,
    }
  }

  private activePage(): MemoryPage {
    const page = this.pages[this.activeIndex]
    if (!page) throw new Error('No active page')
    return page
  }

  private hasControl(selector: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.activePage().controls ?? {}, selector)
  }
}
