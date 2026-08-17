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

export class PatchLayer {
  constructor(private readonly rows: PatchRow[]) {}

  /** Apply this layer over a base row list/map; returns the merged row map. */
  apply(base: PatchRow[] | Map<string, PatchRow>): Map<string, PatchRow> {
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
    return merged
  }

  /** Render the applied rows in determininstic order (by id). */
  dump(rows: Map<string, PatchRow>): PatchRow[] {
    return Array.from(rows.values()).sort((a, b) => a.id.localeCompare(b.id))
  }
}