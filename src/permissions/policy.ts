import type {
  PermissionDecision,
  PermissionResolution,
  PermissionRule,
  TonyTool,
} from '../types.js'

interface SessionGrant {
  sessionId: string
  tool: string
  site?: string
  decision: PermissionResolution
}

function matchesSite(ruleSite: string | undefined, site: string | undefined): boolean {
  if (!ruleSite) return true
  if (!site) return false
  return site === ruleSite || site.endsWith(`.${ruleSite}`)
}

/** Deterministic, fail-closed permission evaluation for host-controlled tools. */
export class PermissionPolicy {
  private readonly rules: PermissionRule[]
  private readonly grants: SessionGrant[] = []

  constructor(rules: PermissionRule[] = []) {
    this.rules = [...rules]
  }

  check(tool: TonyTool, site: string | undefined, sessionId: string): PermissionDecision {
    const grant = this.grants.find((item) => item.sessionId === sessionId && item.tool === tool.name && matchesSite(item.site, site))
    if (grant?.decision === 'allow-session') return 'allow'
    if (grant?.decision === 'deny') return 'deny'

    const matching = this.rules.filter((rule) => rule.tool === tool.name && matchesSite(rule.site, site))
    const siteSpecific = matching.find((rule) => rule.site !== undefined)
    if (siteSpecific) return siteSpecific.decision
    const toolSpecific = matching.find((rule) => rule.site === undefined)
    if (toolSpecific) return toolSpecific.decision

    switch (tool.risk) {
      case 'read': return 'allow'
      case 'light': return 'allow'
      case 'risky': return 'confirm'
      case 'blocked': return 'deny'
    }
  }

  remember(sessionId: string, tool: string, site: string | undefined, resolution: PermissionResolution): void {
    const existing = this.grants.find((item) => item.sessionId === sessionId && item.tool === tool && item.site === site)
    if (existing) existing.decision = resolution
    else this.grants.push({ sessionId, tool, site, decision: resolution })
  }

  clearSession(sessionId: string): void {
    for (let index = this.grants.length - 1; index >= 0; index -= 1) {
      if (this.grants[index]?.sessionId === sessionId) this.grants.splice(index, 1)
    }
  }
}
