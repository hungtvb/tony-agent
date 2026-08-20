/**
 * Plan model — task DAG synthesized from the knowledge graph (v0.8).
 */

export interface TaskNode {
  id: string
  title: string
  description?: string
  entityScope: string[]
  dependsOn: string[]
}

export interface TaskEdge {
  from: string
  to: string
  kind: string
}

export interface Plan {
  goal: string
  tasks: TaskNode[]
  edges: TaskEdge[]
}
