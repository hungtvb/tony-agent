import { z } from 'zod'
import type { ToolContext, ToolResult, TonyTool } from '../types.js'

const empty = z.object({}).strict()
const selectorInput = z.object({ selector: z.string().min(1).max(500) }).strict()
const typeInput = selectorInput.extend({ value: z.string().max(20_000) }).strict()
const amountInput = z.object({ amount: z.number().int().min(-100_000).max(100_000).default(400) }).strict()
const urlInput = z.object({ url: z.string().url().max(4_000) }).strict()
const queryInput = z.object({ query: z.string().min(1).max(1_000) }).strict()
const idInput = z.object({ id: z.string().min(1).max(200) }).strict()
const privacyInput = z.object({ enabled: z.boolean() }).strict()

function requireAdapter(context: ToolContext) {
  if (!context.adapter) throw new Error('This browser tool requires a host adapter')
  return context.adapter
}

function readTool<TInput>(
  name: string,
  description: string,
  inputSchema: z.ZodType<TInput>,
  execute: (input: TInput, context: ToolContext) => Promise<ToolResult> | ToolResult,
): TonyTool<TInput> {
  return {
    name,
    description,
    risk: 'read',
    inputSchema,
    parameters: { type: 'object', properties: {} },
    execute,
  }
}

function lightTool<TInput>(
  name: string,
  description: string,
  inputSchema: z.ZodType<TInput>,
  parameters: Record<string, unknown>,
  execute: (input: TInput, context: ToolContext) => Promise<ToolResult> | ToolResult,
): TonyTool<TInput> {
  return { name, description, risk: 'light', inputSchema, parameters, execute }
}

function riskyTool<TInput>(
  name: string,
  description: string,
  inputSchema: z.ZodType<TInput>,
  parameters: Record<string, unknown>,
  execute: (input: TInput, context: ToolContext) => Promise<ToolResult> | ToolResult,
): TonyTool<TInput> {
  return { name, description, risk: 'risky', inputSchema, parameters, execute }
}

function blockedTool(name: string, description: string): TonyTool {
  return {
    name,
    description,
    risk: 'blocked',
    inputSchema: z.never(),
    parameters: { type: 'object', additionalProperties: false },
    execute: () => ({ content: `Tool ${name} is blocked by default.`, isError: true }),
  }
}

export function createBrowserTools(): TonyTool<any>[] {
  return [
    readTool('browser_get_active_tab', 'Get the active browser tab metadata.', empty, async (_input, context) => ({ content: JSON.stringify(await requireAdapter(context).getActiveTab()) })),
    readTool('browser_list_tabs', 'List open browser tabs.', empty, async (_input, context) => ({ content: JSON.stringify(await requireAdapter(context).listTabs()) })),
    readTool('browser_snapshot', 'Read a compact snapshot of the active page and its controls.', empty, async (_input, context) => ({ content: await requireAdapter(context).snapshot() })),
    readTool('browser_read_page', 'Read the visible text of the active page.', empty, async (_input, context) => ({ content: await requireAdapter(context).readPage() })),
    readTool('browser_extract_article', 'Extract the article-like content from the active page.', empty, async (_input, context) => ({ content: await requireAdapter(context).extractArticle() })),
    readTool('browser_get_selection', 'Read the current page selection.', empty, async (_input, context) => ({ content: await requireAdapter(context).getSelection() })),
    readTool('browser_get_current_url', 'Get the active page URL.', empty, async (_input, context) => ({ content: await requireAdapter(context).getCurrentUrl() })),
    readTool('browser_get_page_title', 'Get the active page title.', empty, async (_input, context) => ({ content: await requireAdapter(context).getPageTitle() })),
    readTool('browser_get_privacy_stats', 'Get host privacy statistics.', empty, async (_input, context) => ({ content: JSON.stringify(await requireAdapter(context).getPrivacyStats()) })),

    lightTool('browser_select_tab', 'Activate an existing tab.', idInput, { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, async (input, context) => { const ok = await requireAdapter(context).selectTab(input.id); return { content: ok ? 'OK' : 'Tab not found', isError: !ok } }),
    lightTool('browser_open_tab', 'Open a new browser tab.', urlInput, { type: 'object', properties: { url: { type: 'string', format: 'uri' } }, required: ['url'] }, async (input, context) => ({ content: JSON.stringify(await requireAdapter(context).openTab(input.url)) })),
    lightTool('browser_scroll', 'Scroll the active page.', amountInput, { type: 'object', properties: { amount: { type: 'integer' } } }, async (input, context) => toResult(await requireAdapter(context).scroll(input.amount ?? 400))),
    lightTool('browser_back', 'Navigate back in the active tab.', empty, { type: 'object', properties: {} }, async (_input, context) => toResult(await requireAdapter(context).back())),
    lightTool('browser_forward', 'Navigate forward in the active tab.', empty, { type: 'object', properties: {} }, async (_input, context) => toResult(await requireAdapter(context).forward())),
    lightTool('browser_reload', 'Reload the active tab.', empty, { type: 'object', properties: {} }, async (_input, context) => toResult(await requireAdapter(context).reload())),
    lightTool('browser_search', 'Search from the active browser host.', queryInput, { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, async (input, context) => toResult(await requireAdapter(context).search(input.query))),
    lightTool('browser_save_page', 'Save the active page.', empty, { type: 'object', properties: {} }, async (_input, context) => toResult(await requireAdapter(context).savePage())),
    lightTool('browser_start_reader', 'Open reader mode for the active page.', empty, { type: 'object', properties: {} }, async (_input, context) => toResult(await requireAdapter(context).startReader())),
    lightTool('browser_start_tts', 'Start text-to-speech for the active page.', empty, { type: 'object', properties: {} }, async (_input, context) => toResult(await requireAdapter(context).startTts())),

    riskyTool('browser_click', 'Click a page control. Requires host confirmation.', selectorInput, { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] }, async (input, context) => toResult(await requireAdapter(context).click(input.selector))),
    riskyTool('browser_type', 'Type into a page control. Requires host confirmation.', typeInput, { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'] }, async (input, context) => toResult(await requireAdapter(context).type(input.selector, input.value))),
    riskyTool('browser_submit_form', 'Submit a page form. Requires host confirmation.', selectorInput, { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] }, async (input, context) => toResult(await requireAdapter(context).submitForm(input.selector))),
    riskyTool('browser_download', 'Download a resource. Requires host confirmation.', urlInput, { type: 'object', properties: { url: { type: 'string', format: 'uri' } }, required: ['url'] }, async (input, context) => toResult(await requireAdapter(context).download(input.url))),
    riskyTool('browser_upload', 'Upload a local file. Requires host confirmation.', z.object({ selector: z.string().min(1), path: z.string().min(1).max(4_000) }).strict(), { type: 'object', properties: { selector: { type: 'string' }, path: { type: 'string' } }, required: ['selector', 'path'] }, async (input, context) => toResult(await requireAdapter(context).upload(input.selector, input.path))),
    riskyTool('browser_delete_saved_page', 'Delete a saved page. Requires host confirmation.', idInput, { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, async (input, context) => toResult(await requireAdapter(context).deleteSavedPage(input.id))),
    riskyTool('browser_close_tab', 'Close a browser tab. Requires host confirmation.', idInput, { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, async (input, context) => { const ok = await requireAdapter(context).closeTab(input.id); return { content: ok ? 'OK' : 'Tab not found', isError: !ok } }),
    riskyTool('browser_change_privacy_setting', 'Change a privacy setting. Requires host confirmation.', privacyInput, { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] }, async (input, context) => toResult(await requireAdapter(context).changePrivacySetting(input.enabled))),
    blockedTool('browser_execute_script', 'Execute arbitrary page JavaScript. Blocked by default.'),
  ]
}

function toResult(result: { ok: boolean; error?: string; data?: unknown }): { content: string; isError?: boolean; data?: unknown } {
  return result.ok
    ? { content: result.data === undefined ? 'OK' : JSON.stringify(result.data), ...(result.data === undefined ? {} : { data: result.data }) }
    : { content: result.error ?? 'Host action failed', isError: true }
}
