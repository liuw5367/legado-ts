import { useContext, useEffect, useEffectEvent, useRef } from 'react'
import { NavigationContext, PageContext } from './navigation-context.tsx'
import { PageResource } from './page-data.ts'

export function usePageActivity() { return useContext(PageContext) }
export function usePageNavigation() { return useContext(NavigationContext) }
export function usePageVersion(domains: string[]) {
  const navigation = usePageNavigation()
  return domains.map((domain) => navigation?.versions.get(domain) ?? 0).join(':')
}

/** Effect 的清理属于可见生命周期；读取是否已结算独立于 Activity 的重新挂载。 */
export function usePageLoadEffect(effect: (settle: () => void) => void | (() => void), dependencies: readonly (string | number | boolean | null | undefined)[], domains: string[] = []) {
  const page = usePageActivity()
  const version = usePageVersion(domains)
  const resource = useRef(new PageResource())
  const onLoad = useEffectEvent(effect)
  const identity = JSON.stringify([...dependencies, version])
  useEffect(() => {
    if (page?.active === false) return
    const run = resource.current.begin(identity)
    if (run === undefined) return
    const cleanup = onLoad(run.settle)
    return () => { cleanup?.(); run.cancel() }
  }, [identity, page?.active])
}
