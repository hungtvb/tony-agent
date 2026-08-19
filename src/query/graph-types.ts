/** Graph knowledge-layer types (v0.6). */

/** One entity in the knowledge graph (canonical name, per session). */
export interface GraphEntity {
  name: string
  type: string
  description?: string
}

/** A directed relation between two entity names. */
export interface GraphRelation {
  source: string
  target: string
  kind: string
  description?: string
}
