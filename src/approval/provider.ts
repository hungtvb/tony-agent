import type { PermissionRequest, PermissionResolution } from '../types.js'

/** A resolver that decides confirm-type permission requests. */
export interface ApprovalResolver {
  (request: PermissionRequest): Promise<PermissionResolution> | PermissionResolution
}

export interface ApprovalProviderOptions {
  /** Resolver for `confirm` decisions. Omit to degrade to `deny`. */
  resolver?: ApprovalResolver
  /** Fallback when resolver is absent or fails. Defaults to `deny`. */
  fallback?: PermissionResolution
  /** On resolver error, use fallback instead of failing the call. */
  failClosed?: boolean
}

/**
 * Approval seam (dsh-style): policies emit `confirm`; the mounted approval
 * provider turns it into allow-once / allow-session / deny. With no provider
 * mounted (or no resolver), the ask degrades to `deny` — fail-closed.
 */
export class ApprovalProvider {
  private readonly resolver?: ApprovalResolver
  private readonly fallback: PermissionResolution
  private readonly failClosed: boolean

  constructor(options: ApprovalProviderOptions = {}) {
    this.resolver = options.resolver
    this.fallback = options.fallback ?? 'deny'
    this.failClosed = options.failClosed ?? true
  }

  async resolve(request: PermissionRequest): Promise<PermissionResolution> {
    if (!this.resolver) return this.fallback
    try {
      const resolution = await this.resolver(request)
      if (resolution === 'allow-once' || resolution === 'allow-session' || resolution === 'deny') {
        return resolution
      }
      return this.fallback
    } catch {
      return this.fallback
    }
  }
}
