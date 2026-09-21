import type { MemoryVariableOptions, RuleVariableView, VariableScope } from './types.ts'

const readOrder: readonly VariableScope[] = ['local', 'chapter', 'book', 'rule-data', 'source']

export class MemoryVariableView implements RuleVariableView {
  private readonly values = new Map<VariableScope, Map<string, string>>()
  private readonly availableScopes: readonly VariableScope[]

  public constructor(options: MemoryVariableOptions = {}) {
    this.availableScopes = options.availableScopes ?? ['chapter', 'book', 'rule-data', 'source']
    for (const scope of readOrder) this.values.set(scope, new Map(Object.entries(options.initial?.[scope] ?? {})))
  }

  public get(name: string): string | undefined {
    const local = this.values.get('local')!
    if (local.has(name)) return local.get(name)
    for (const scope of readOrder.slice(1)) {
      const value = this.values.get(scope)!.get(name)
      if (value !== undefined && value !== '') return value
    }
    return undefined
  }

  public set(name: string, value: string | null, scope?: VariableScope): void {
    const target = scope ?? this.availableScopes[0] ?? 'rule-data'
    const store = this.values.get(target)!
    if (value === null) store.delete(name)
    else store.set(name, value)
  }

  public delete(name: string, scope?: VariableScope): void {
    this.values.get(scope ?? this.availableScopes[0] ?? 'rule-data')!.delete(name)
  }

  public has(name: string): boolean {
    const local = this.values.get('local')!
    if (local.has(name)) return true
    return readOrder.slice(1).some((scope) => {
      const value = this.values.get(scope)!.get(name)
      return value !== undefined && value !== ''
    })
  }

  public snapshot(scope?: VariableScope): Readonly<Record<string, string>> {
    if (scope !== undefined) return Object.fromEntries(this.values.get(scope)!)
    const merged: Record<string, string> = {}
    for (const current of [...readOrder].reverse()) Object.assign(merged, Object.fromEntries(this.values.get(current)!))
    return merged
  }
}

export function snapshotVariables(view: RuleVariableView): Record<VariableScope, Readonly<Record<string, string>>> {
  return Object.fromEntries(readOrder.map((scope) => [scope, view.snapshot(scope)])) as Record<VariableScope, Readonly<Record<string, string>>>
}

export function variableChanges(before: Record<VariableScope, Readonly<Record<string, string>>>, after: Record<VariableScope, Readonly<Record<string, string>>>) {
  const changes: Array<{ scope: VariableScope; name: string; before?: string; after?: string }> = []
  for (const scope of readOrder) {
    const names = new Set([...Object.keys(before[scope]), ...Object.keys(after[scope])])
    for (const name of names) {
      const left = before[scope][name]
      const right = after[scope][name]
      if (left !== right) {
        const change: { scope: VariableScope; name: string; before?: string; after?: string } = { scope, name }
        if (left !== undefined) change.before = left
        if (right !== undefined) change.after = right
        changes.push(change)
      }
    }
  }
  return changes
}
