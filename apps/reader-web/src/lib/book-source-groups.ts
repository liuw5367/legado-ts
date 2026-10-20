import type { BookSourceItem } from '../../shared/book-sources.ts'
import { compareSourceManagementOrder, groupSourcesByDomain, selectOneSourcePerDomain, sourceDomainInfo } from '../../shared/source-domain.ts'
import type { ManagedSourceSummary } from '../../shared/source-management.ts'

export interface BookSourceSearchResultRef {
  sourceId: string
  index: number
}

export interface BookSourceImplementation<T extends BookSourceSearchResultRef = BookSourceSearchResultRef> {
  source: ManagedSourceSummary
  displayName: string
  items: BookSourceItem[]
  searchResults: T[]
  isAccountDefault: boolean
}

export interface BookSourceDomainGroup<T extends BookSourceSearchResultRef = BookSourceSearchResultRef> {
  domainKey: string
  domain: string
  versions: BookSourceImplementation<T>[]
}

export function groupBookSourcesByDomain<T extends BookSourceSearchResultRef>(managedSources: readonly ManagedSourceSummary[], bookSources: readonly BookSourceItem[], searchResults: readonly T[]): BookSourceDomainGroup<T>[] {
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
  const defaults = new Map(selectOneSourcePerDomain(managedSources.filter((source) => source.enabled), compareSourceManagementOrder).map((source) => [sourceDomainInfo(source.sourceId).key, source]))

  return groupSourcesByDomain(managedSources)
    .filter((group) => relatedDomains.has(group.domainKey))
    .map((group) => ({
      domainKey: group.domainKey,
      domain: group.domain,
      versions: group.versions.map(({ source, displayName }) => ({
        source,
        displayName,
        items: itemsBySourceId.get(source.sourceId) ?? [],
        searchResults: searchResultsBySourceId.get(source.sourceId) ?? [],
        isAccountDefault: defaults.get(group.domainKey)?.sourceId === source.sourceId,
      })),
    }))
}
