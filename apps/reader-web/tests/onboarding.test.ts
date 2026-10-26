import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { hasSeenOnboarding, markOnboardingSeen } from '../src/lib/onboarding.ts'

test('引导记录按账号和版本隔离，并在存储不可用时保留当前会话状态', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  } as Storage
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } })

  try {
    const suffix = randomUUID()
    const first = `onboarding-first-${suffix}`
    const second = `onboarding-second-${suffix}`
    const stale = `onboarding-stale-${suffix}`
    const current = `onboarding-current-${suffix}`
    const unavailable = `onboarding-unavailable-${suffix}`

    assert.equal(hasSeenOnboarding(first), false)
    markOnboardingSeen(first)
    assert.equal(hasSeenOnboarding(first), true)
    assert.equal(hasSeenOnboarding(second), false)
    values.set(`legado:onboarding:v1:${encodeURIComponent(stale)}`, '{"version":2,"seen":true}')
    assert.equal(hasSeenOnboarding(stale), false)
    values.set(`legado:onboarding:v1:${encodeURIComponent(current)}`, '{"version":1,"seen":true}')
    assert.equal(hasSeenOnboarding(current), true)

    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      localStorage: {
        getItem() { throw new Error('存储不可用') },
        setItem() { throw new Error('存储不可用') },
      },
    } })
    assert.doesNotThrow(() => markOnboardingSeen(unavailable))
    assert.equal(hasSeenOnboarding(unavailable), true)
  } finally {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
    else Object.defineProperty(globalThis, 'window', previousWindow)
  }
})
