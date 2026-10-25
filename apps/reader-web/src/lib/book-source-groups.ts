import type { BookSourceItem } from '../../shared/book-sources.ts'
import { compareSourceManagementOrder, groupSourcesByDomain, selectOneSourcePerDomain, sourceDomainInfo } from '../../shared/source-domain.ts'
import type { ManagedSourceSummary } from '../../shared/source-management.ts'

export interface BookSourceSearchResultRef {
  sourceId: string
  index: number
  searchDurationMs?: number | undefined
}

export interface BookSourceImplementation<T extends BookSourceSearchResultRef = BookSourceSearchResultRef> {
  source: ManagedSourceSummary
  displayName: string
  items: BookSourceItem[]
  searchResults: T[]
  isAccountDefault: boolean
  isCurrentBookEdition: boolean
  searchDurationMs: number | undefined
}

export interface BookSourceDomainGroup<T extends BookSourceSearchResultRef = BookSourceSearchResultRef> {
  domainKey: string
  domain: string
  versions: BookSourceImplementation<T>[]
}

export function groupBookSourcesByDomain<T extends BookSourceSearchResultRef>(managedSources: readonly ManagedSourceSummary[], bookSources: readonly BookSourceItem[], searchResults: readonly T[], activeEditionKey?: string): BookSourceDomainGroup<T>[] {
  const itemsBySourceId = new Map<string, BookSourceItem[]>()
  for (const item of bookSources) {
    const items = itemsBySourceId.get(item.sourceId) ?? []
    items.push(item)
    itemsBySourceId.set(item.sourceId, items)
  }

  const searchResultsBySourceId = new Map<string, T[]>()
  for (const result of searchResults) {
    const results = searchResultsBySourceId.get(result.sourceId) ?? []
    results.push(result)
    searchResultsBySourceId.set(result.sourceId, results)
  }

  const relatedDomains = new Set([
    ...bookSources.map((source) => sourceDomainInfo(source.sourceId).key),
    ...searchResults.map((result) => sourceDomainInfo(result.sourceId).key),
  ])
  const activeSourceId = bookSources.find((item) => item.status === 'saved' && item.editionKey === activeEditionKey)?.sourceId
  const activeDomainKey = activeSourceId === undefined ? undefined : sourceDomainInfo(activeSourceId).key
  const defaults = new Map(selectOneSourcePerDomain(managedSources.filter((source) => source.enabled), compareSourceManagementOrder).map((source) => [sourceDomainInfo(source.sourceId).key, source]))

  return groupSourcesByDomain(managedSources)
    .filter((group) => relatedDomains.has(group.domainKey))
    .sort((left, right) => Math.min(...left.versions.map(({ source }) => source.importPriority ?? Number.MAX_SAFE_INTEGER)) - Math.min(...right.versions.map(({ source }) => source.importPriority ?? Number.MAX_SAFE_INTEGER)))
    .map((group) => ({
      domainKey: group.domainKey,
      domain: group.domain,
      versions: [...group.versions].sort((left, right) => (left.source.importPriority ?? Number.MAX_SAFE_INTEGER) - (right.source.importPriority ?? Number.MAX_SAFE_INTEGER) || compareSourceManagementOrder(left.source, right.source)).map(({ source, displayName }) => ({
        source,
        displayName,
        items: itemsBySourceId.get(source.sourceId) ?? [],
        searchResults: searchResultsBySourceId.get(source.sourceId) ?? [],
        isAccountDefault: defaults.get(group.domainKey)?.sourceId === source.sourceId,
        isCurrentBookEdition: source.sourceId === activeSourceId,
        searchDurationMs: searchResultsBySourceId.get(source.sourceId)?.find((result) => result.searchDurationMs !== undefined)?.searchDurationMs
          ?? itemsBySourceId.get(source.sourceId)?.find((item) => item.searchDurationMs !== undefined)?.searchDurationMs,
      })).sort((left, right) => Number(right.isCurrentBookEdition) - Number(left.isCurrentBookEdition)
        || (group.domainKey === activeDomainKey ? 0 : Number(right.isAccountDefault) - Number(left.isAccountDefault))
        || (left.searchDurationMs ?? Infinity) - (right.searchDurationMs ?? Infinity)),
    }))
    .sort((left, right) => Number(right.versions.some((version) => version.isCurrentBookEdition)) - Number(left.versions.some((version) => version.isCurrentBookEdition))
      || ((left.versions.find((version) => version.isCurrentBookEdition || version.isAccountDefault) ?? left.versions[0])?.searchDurationMs ?? Infinity)
        - ((right.versions.find((version) => version.isCurrentBookEdition || version.isAccountDefault) ?? right.versions[0])?.searchDurationMs ?? Infinity))
}
