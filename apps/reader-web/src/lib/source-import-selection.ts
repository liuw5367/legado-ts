export function updateImportSelection(selected: readonly string[], visibleIds: readonly string[], action: 'all' | 'invert' | 'clear'): string[] {
  const next = new Set(selected)
  for (const id of visibleIds) {
    if (action === 'clear' || (action === 'invert' && next.has(id))) next.delete(id)
    else next.add(id)
  }
  return [...next]
}
