/**
 * workspace 文件变更归并。
 * 移植自主仓 desktop/src/chat-ui/composables/workspaceChanges.js(整文件逐字移植,注释保留)。
 */

/** 单个文件变更(path 键唯一,operation 归一为大写) */
export interface WorkspaceChange {
  path: string
  operation?: string
  size?: number | null
  [key: string]: unknown
}

/** 步骤树的最小结构(与 engine/timeline.ts 的 TimelineStep 结构兼容) */
export interface WorkspaceStepLike {
  type?: string
  name?: string
  ok?: boolean
  args?: string
  steps?: WorkspaceStepLike[] | null
}

/** 将同一回合内多次文件操作归并成相对回合开始状态的最终变化。 */
export function mergeWorkspaceChanges(existing?: WorkspaceChange[] | null, incoming?: WorkspaceChange[] | null): WorkspaceChange[] {
  const byPath = new Map<string, WorkspaceChange>()
  for (const item of existing || []) {
    if (item?.path) {
      const op = String(item.operation || 'MODIFY').toUpperCase()
      byPath.set(item.path, { ...item, operation: op })
    }
  }
  for (const raw of incoming || []) {
    if (!raw?.path) continue
    const item = {
      ...raw,
      operation: String(raw.operation || 'MODIFY').toUpperCase()
    }
    const previous = byPath.get(item.path)
    if (!previous) {
      byPath.set(item.path, item)
      continue
    }
    const operation = mergeOperation(previous.operation, item.operation)
    if (!operation) {
      byPath.delete(item.path)
    } else {
      byPath.set(item.path, { ...previous, ...item, operation })
    }
  }
  return Array.from(byPath.values())
}

function mergeOperation(previous: string | undefined, next: string | undefined): string | null {
  if (previous === 'CREATE' && next === 'MODIFY') return 'CREATE'
  if (previous === 'CREATE' && next === 'DELETE') return null
  if (previous === 'MODIFY' && next === 'DELETE') return 'DELETE'
  if (previous === 'DELETE' && next === 'CREATE') return 'MODIFY'
  return next!
}

export function workspaceChangeCounts(changes?: WorkspaceChange[] | null): { total: number, created: number, modified: number, deleted: number } {
  const out = { total: 0, created: 0, modified: 0, deleted: 0 }
  for (const item of changes || []) {
    out.total++
    const op = String(item.operation || '').toUpperCase()
    if (op === 'CREATE' || op === 'ADD' || op === 'NEW') out.created++
    else if (op === 'DELETE' || op === 'REMOVE') out.deleted++
    else out.modified++
  }
  return out
}

/**
 * 将多个回合的增量事件归并成一个会话级变更集。
 */
export function mergeWorkspaceChangeSets(turns?: Array<{ workspaceChanges?: WorkspaceChange[] | null }> | null): WorkspaceChange[] {
  let result: WorkspaceChange[] = []
  for (const turn of turns || []) {
    result = mergeWorkspaceChanges(result, turn?.workspaceChanges || [])
  }
  return result.sort((a, b) => String(a.path || '').localeCompare(String(b.path || '')))
}

/** 从步骤树中回退提取文件变更 (当 backend ui artifact 丢失时的兜底保证) */
export function collectFileChangesFromSteps(steps?: WorkspaceStepLike[] | null): WorkspaceChange[] {
  const changes: WorkspaceChange[] = []
  const seen = new Set<string>()
  for (const s of steps || []) {
    if (s.type === 'tool' && s.ok !== false) {
      const n = (s.name || '').toLowerCase()
      let op: string | null = null
      if (n === 'write' || n === 'write_to_file' || n === 'createfile' || n === 'create_file') op = 'CREATE'
      else if (n === 'edit' || n === 'replace_file_content' || n === 'editfile' || n === 'edit_file') op = 'MODIFY'
      else if (n === 'delete' || n === 'delete_file' || n === 'remove_file') op = 'DELETE'

      if (op && s.args) {
        try {
          const obj = typeof s.args === 'string' ? JSON.parse(s.args) : s.args
          const p = obj.path || obj.file || obj.filePath || obj.targetFile || obj.TargetFile
          if (p && !seen.has(p)) {
            seen.add(p)
            changes.push({ path: p, operation: op, size: null })
          }
        } catch (_) {}
      }
    }
    if (s.steps && s.steps.length) {
      const sub = collectFileChangesFromSteps(s.steps)
      for (const item of sub) {
        if (!seen.has(item.path)) {
          seen.add(item.path)
          changes.push(item)
        }
      }
    }
  }
  return changes
}
