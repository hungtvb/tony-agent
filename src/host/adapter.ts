import type { BrowserTab } from '../types.js'

/** Host boundary for browser capabilities. The agent core never imports Electron. */
export interface PageAdapter {
  snapshot(): Promise<string>
  readPage(): Promise<string>
  extractArticle(): Promise<string>
  getSelection(): Promise<string>
  getCurrentUrl(): Promise<string>
  getPageTitle(): Promise<string>
  getActiveTab(): Promise<BrowserTab | undefined>
  listTabs(): Promise<BrowserTab[]>
  selectTab(id: string): Promise<boolean>
  openTab(url: string): Promise<BrowserTab>
  closeTab(id: string): Promise<boolean>
  click(selector: string): Promise<{ ok: boolean; error?: string }>
  type(selector: string, value: string): Promise<{ ok: boolean; error?: string }>
  submitForm(selector: string): Promise<{ ok: boolean; error?: string }>
  scroll(amount: number): Promise<{ ok: boolean; error?: string }>
  navigate(url: string): Promise<{ ok: boolean; error?: string }>
  back(): Promise<{ ok: boolean; error?: string }>
  forward(): Promise<{ ok: boolean; error?: string }>
  reload(): Promise<{ ok: boolean; error?: string }>
  search(query: string): Promise<{ ok: boolean; error?: string }>
  savePage(): Promise<{ ok: boolean; error?: string }>
  startReader(): Promise<{ ok: boolean; error?: string }>
  startTts(): Promise<{ ok: boolean; error?: string }>
  download(url?: string): Promise<{ ok: boolean; error?: string }>
  upload(selector: string, path: string): Promise<{ ok: boolean; error?: string }>
  deleteSavedPage(id: string): Promise<{ ok: boolean; error?: string }>
  changePrivacySetting(enabled: boolean): Promise<{ ok: boolean; error?: string }>
  getPrivacyStats(): Promise<unknown>
}

export function getSiteFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

export function okResult(data?: unknown): { ok: boolean; data?: unknown } {
  return data === undefined ? { ok: true } : { ok: true, data }
}

export function errorResult(error: unknown): { ok: boolean; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

export { type PageAdapter as BrowserHostAdapter }
