/**
 * planToScript + executePlan — DAG execution of a graph-synthesized plan (v0.8).
 *
 * The script walks the plan topologically: each task with all dependencies
 * 'done' becomes ready; each ready task runs via `ctx.agent()` (one agent per
 * task). Failures mark the task 'failed' and its dependents 'skipped'; the
 * plan continues with whatever remains runnable. `ctx.agent()` honors the
 * engine's `maxTotalAgents` cap (AGENT_CAP propagates as failure).
 */
import type { WorkflowEngine, WorkflowRun, WorkflowScript } from '../workflow/engine.js'
import type { Plan, TaskNode } from './types.js'

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface PlanExecutionResult {
  results: Record<string, unknown>
  status: Record<string, TaskStatus>
}

export function buildTaskPrompt(task: TaskNode, goal: string): string {
  const scope = task.entityScope.length > 0 ? `\nEntity scope: ${task.entityScope.join(', ')}` : ''
  const deps = task.dependsOn.length > 0 ? `\nDepends on: ${task.dependsOn.join(', ')}` : ''
  return `[plan task] ${task.title}${scope}${deps}\nGoal: ${goal}`
}

export function planToScript(plan: Plan): WorkflowScript {
  return async (ctx): Promise<PlanExecutionResult> => {
    const results: Record<string, unknown> = {}
    const status: Record<string, TaskStatus> = {}
    for (const task of plan.tasks) status[task.id] = 'pending'

    while (true) {
      const ready = plan.tasks.filter(
        (t) => status[t.id] === 'pending' && t.dependsOn.every((d) => status[d] === 'done'),
      )
      if (ready.length === 0) break
      for (const task of ready) {
        status[task.id] = 'running'
        try {
          results[task.id] = await ctx.agent({ prompt: buildTaskPrompt(task, plan.goal) })
          status[task.id] = 'done'
        } catch {
          status[task.id] = 'failed'
        }
      }
    }

    // Propagate skip to dependents of failed tasks (never run).
    for (const task of plan.tasks) {
      if (status[task.id] === 'pending') {
        const blocked = task.dependsOn.some((d) => status[d] === 'failed' || status[d] === 'skipped')
        if (blocked) status[task.id] = 'skipped'
      }
    }

    return { results, status }
  }
}

export function executePlan(engine: WorkflowEngine, plan: Plan): WorkflowRun {
  return engine.start(planToScript(plan))
}