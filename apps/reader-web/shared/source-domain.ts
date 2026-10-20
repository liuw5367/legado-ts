export interface SourceDomainVersionLike {
  sourceId: string
  name: string
  /** 来源 JSON 中的规则更新时间（Unix 毫秒），不使用 reader-web 的本地更新时间。 */
  lastUpdateTime?: number
  customOrder?: number
}

export interface GroupedSourceVersion<T> {
  source: T
  displayName: string
}

export interface SourceDomainGroup<T> {
  domainKey: string
  domain: string
  versions: GroupedSourceVersion<T>[]
}

/** 以主机名和非默认端口分组；无效书源地址保留完整 sourceId，避免误合并。 */
export function sourceDomainInfo(sourceId: string): { key: string; domain: string } {
  try {
    const url = new URL(sourceId)
    if (url.hostname.length > 0) {
      const domain = url.host.toLowerCase()
      return { key: `host:${domain}`, domain }
    }
  } catch {
    // Invalid source IDs remain separate instead of being merged by a partial parse.
  }
  return { key: `source:${sourceId}`, domain: sourceId }
}

export function isValidSourceRuleTime(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && Number.isFinite(new Date(value).getTime())
}

export function compareSourceManagementOrder<T extends { sourceId: string; customOrder?: number }>(left: T, right: T): number {
  const leftOrder = Number.isSafeInteger(left.customOrder) ? left.customOrder! : 0
  const rightOrder = Number.isSafeInteger(right.customOrder) ? right.customOrder! : 0
  return leftOrder - rightOrder || compareSourceIds(left.sourceId, right.sourceId)
}

export function compareSourceVersions<T extends SourceDomainVersionLike>(left: T, right: T): number {
  const leftTime = isValidSourceRuleTime(left.lastUpdateTime) ? left.lastUpdateTime : undefined
  const rightTime = isValidSourceRuleTime(right.lastUpdateTime) ? right.lastUpdateTime : undefined
  if (leftTime !== rightTime) {
    if (leftTime === undefined) return 1
    if (rightTime === undefined) return -1
    return rightTime - leftTime
  }
  return compareSourceManagementOrder(left, right)
}

export function groupSourcesByDomain<T extends SourceDomainVersionLike>(sources: readonly T[]): SourceDomainGroup<T>[] {
  const grouped = new Map<string, { domain: string; versions: T[] }>()
  for (const source of sources) {
    const info = sourceDomainInfo(source.sourceId)
    const group = grouped.get(info.key) ?? { domain: info.domain, versions: [] }
    group.versions.push(source)
    grouped.set(info.key, group)
  }

  return [...grouped.entries()]
    .sort(([leftKey, left], [rightKey, right]) => left.domain.localeCompare(right.domain) || leftKey.localeCompare(rightKey))
    .map(([domainKey, group]) => {
      const versions = [...group.versions].sort(compareSourceVersions)
      const sameNames = new Map<string, Map<string, T[]>>()
      for (const source of versions) {
        const key = normalizeSourceName(source.name)
        const matchesById = sameNames.get(key) ?? new Map<string, T[]>()
        const matches = matchesById.get(source.sourceId) ?? []
        matches.push(source)
        matchesById.set(source.sourceId, matches)
        sameNames.set(key, matchesById)
      }

      const numberBySource = new Map<T, number>()
      for (const matchesById of sameNames.values()) {
        const sourceIds = [...matchesById.keys()].sort(compareSourceIds)
        if (sourceIds.length < 2) continue
        sourceIds.forEach((sourceId, index) => {
          for (const source of matchesById.get(sourceId) ?? []) numberBySource.set(source, index + 1)
        })
      }

      return {
        domainKey,
        domain: group.domain,
        versions: versions.map((source) => {
          const name = source.name.trim()
          const number = numberBySource.get(source)
          return { source, displayName: number === undefined ? name : `${name} #${number}` }
        }),
      }
    })
}

/** 旧数据可能有多个启用版本；调用方比较器决定确定性的有效版本，不写回修复数据库。 */
export function selectOneSourcePerDomain<T extends { sourceId: string }>(sources: readonly T[], compare: (left: T, right: T) => number): T[] {
  const selected = new Map<string, T>()
  for (const source of sources) {
    const key = sourceDomainInfo(source.sourceId).key
    const previous = selected.get(key)
    if (previous === undefined || compare(source, previous) < 0) selected.set(key, source)
  }
  return [...selected.values()].sort(compare)
}

function normalizeSourceName(value: string): string {
  return value.trim().normalize('NFC').toLowerCase()
}

function compareSourceIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
