/**
 * PatchLayer — dsh-style config patching by row id.
 *
 * A patch targets a row by id and replaces its whole config (or disables it).
 * Layers apply to an empty entry list in order; later layers win. This is the
 * composition mechanism behind profiles/bundles.
 */
export interface PatchRow {
  id: string
  plugin: string
  config?: unknown
  disabled?: boolean
}

/** A schema violation for one patch row. */
export interface PatchSchemaError {
  row: string
  issues: string[]
}

export interface PatchLayerOptions {
  /** When true (default), throw on the first invalid row in `apply`. */
  strict?: boolean
}

/** Validate one row's shape; returns human-readable issues (empty = valid). */
export function validatePatchRow(row: PatchRow): string[] {
  const issues: string[] = []
  if (typeof row.id !== 'string' || row.id.trim() === '') {
    issues.push('id must be a non-empty string')
  }
  if (typeof row.plugin !== 'string' || row.plugin.trim() === '') {
    issues.push('plugin must be a non-empty string')
  }
  if (row.config !== undefined) {
    const isPlainObject = typeof row.config === 'object' && row.config !== null && !Array.isArray(row.config)
    if (!isPlainObject) issues.push('config must be a plain object')
  }
  if (row.disabled !== undefined && typeof row.disabled !== 'boolean') {
    issues.push('disabled must be a boolean')
  }
  return issues
}

/** Validate a list of patch rows; returns one entry per invalid row. */
export function validatePatchRows(rows: PatchRow[]): PatchSchemaError[] {
  const errors: PatchSchemaError[] = []
  for (const row of rows) {
    const issues = validatePatchRow(row)
    if (issues.length > 0) errors.push({ row: row.id, issues })
  }
  return errors
}

export class PatchLayer {
  private readonly rows: PatchRow[]
  private readonly strict: boolean
  /** Per-session overrides: sessionId → (rowId → override row). Never mutates rows. */
  private readonly sessionOverrides = new Map<string, Map<string, PatchRow>>()

  constructor(rows: PatchRow[], options: PatchLayerOptions = {}) {
    this.strict = options.strict ?? true
    this.rows = this.strict ? assertValidRows(rows) : rows
  }

  /** Apply this layer over a base row list/map; returns the merged row map. */
  apply(base: PatchRow[] | Map<string, PatchRow>, sessionId?: string): Map<string, PatchRow> {
    const merged = new Map<string, PatchRow>()
    if (base instanceof Map) {
      for (const [id, row] of Array.from(base.entries())) merged.set(id, row)
    } else {
      for (const row of base) merged.set(row.id, row)
    }
    for (const row of this.rows) {
      if (row.disabled) {
        merged.delete(row.id)
        continue
      }
      const existing = merged.get(row.id)
      const next: PatchRow = {
        id: row.id,
        plugin: row.plugin,
        config: row.config ?? existing?.config,
        disabled: false,
      }
      merged.set(row.id, next)
    }
    if (sessionId) {
      const overrides = this.sessionOverrides.get(sessionId)
      if (overrides) {
        for (const row of Array.from(overrides.values())) {
          if (row.disabled) {
            merged.delete(row.id)
            continue
          }
          const existing = merged.get(row.id)
          merged.set(row.id, {
            id: row.id,
            plugin: row.plugin,
            config: row.config ?? existing?.config,
            disabled: false,
          })
        }
      }
    }
    return merged
  }

  /** Override a row for ONE session only. Later overlays win; does not touch rows.
   *  A disabled marker hides the row for that session (re-enable by re-applying
   *  a config row); clearSession drops all overrides for the session. */
  applyForSession(sessionId: string, row: PatchRow): void {
    if (this.strict) {
      const issues = validatePatchRow(row)
      if (issues.length > 0) throw new Error(`Invalid patch row for session ${sessionId}: ${issues.join('; ')}`)
    }
    let overrides = this.sessionOverrides.get(sessionId)
    if (!overrides) {
      overrides = new Map()
      this.sessionOverrides.set(sessionId, overrides)
    }
    overrides.set(row.id, row)
  }

  /** Drop all per-session overrides for a session (e.g. session deleted). */
  clearSession(sessionId: string): void {
    this.sessionOverrides.delete(sessionId)
  }

  /** Render the applied rows in determininstic order (by id). */
  dump(rows: Map<string, PatchRow>): PatchRow[] {
    return Array.from(rows.values()).sort((a, b) => a.id.localeCompare(b.id))
  }

  /** Number of sessions with active overrides. */
  get sessionOverrideCount(): number {
    return this.sessionOverrides.size
  }
}

function assertValidRows(rows: PatchRow[]): PatchRow[] {
  const errors = validatePatchRows(rows)
  if (errors.length > 0) {
    const detail = errors
      .map((error) => `  row "${error.row}": ${error.issues.join('; ')}`)
      .join('\n')
    throw new Error(`Invalid patch rows:\n${detail}`)
  }
  return rows
}