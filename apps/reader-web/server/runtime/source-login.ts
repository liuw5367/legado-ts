import type { SourceSession, WorkflowAction, WorkflowRulePort } from '@legado/source-core'
import type { SourceLoginActionInput, SourceLoginActionResult, SourceLoginField, SourceLoginUi, SourceLoginWorkflowAction } from '../../shared/source-login.ts'
import type { ReaderRepository, StoredSourceRecord } from '../db/repository.ts'
import { ReaderRuntimeError, requireSource, withPersistentSourceSession } from './source-session.ts'

const LOGIN_RULE_LIMIT = 256 * 1024
const LOGIN_INPUT_LIMIT = 1024 * 1024

export async function getSourceLoginUi(repository: ReaderRepository, userId: string, sourceId: string, expectedFingerprint?: string, signal?: AbortSignal): Promise<SourceLoginUi> {
  const source = await requireSource(repository, userId, sourceId)
  if (expectedFingerprint !== undefined && expectedFingerprint !== source.fingerprint) throw new ReaderRuntimeError('invalid-input', '书源已更新，请刷新后重试')
  return withPersistentSourceSession(repository, userId, source, async (session) => {
    const staticFields = parseStaticFields(source.normalizedSource.loginUi)
    const result = await session.run((ports) => evaluateLoginUi(ports.rules, source, session, staticFields, signal))
    return { sourceId: source.sourceId, fingerprint: source.fingerprint, ...result }
  })
}

export async function submitSourceLogin(repository: ReaderRepository, userId: string, input: SourceLoginActionInput, signal?: AbortSignal): Promise<SourceLoginActionResult> {
  const source = await requireSource(repository, userId, input.sourceId)
  if (source.fingerprint !== input.fingerprint) throw new ReaderRuntimeError('invalid-input', '书源已更新，请刷新后重试')
  return withPersistentSourceSession(repository, userId, source, async (session) => session.run(async (ports) => {
    const staticFields = parseStaticFields(source.normalizedSource.loginUi)
    const dynamic = isLoginUiV2(source.normalizedSource.loginUi)
    const state = input.state ?? Object.fromEntries(Object.entries(input.form).map(([key, value]) => [key, String(value)]))
    const stateJson = JSON.stringify(state)
    const formJson = JSON.stringify(input.form)
    if (stateJson === undefined || formJson === undefined || stateJson.length + formJson.length > LOGIN_INPUT_LIMIT) throw new ReaderRuntimeError('invalid-input', '登录状态或表单过大')
    if (!dynamic && input.action !== undefined && input.action.length > 0 && !staticFields.some((field) => field.action === input.action)) throw new ReaderRuntimeError('invalid-input', '登录控件动作无效')
    const code = dynamic
      ? `var __result = source.evalLoginActionV2(${JSON.stringify(input.action ?? 'submit')}, ${JSON.stringify(stateJson)}, ${JSON.stringify(formJson)}); var __command = __result; try { if (typeof __result === "string") __command = JSON.parse(__result); } catch {} if (__command && typeof __command === "object" && __command.login && typeof __command.login === "object") source.putLoginInfoMap(__command.login); JSON.stringify({ result: __result, values: source.getLoginInfoMap() });`
      : staticFields.length === 0
        ? 'throw new Error("登录表单为空")'
        : input.action?.trim().length
          ? isOpenableAction(input.action) ? `JSON.stringify({ result: ${JSON.stringify(input.action.trim())}, values: source.getLoginInfoMap() });` : `var __result = source.evalJS(${JSON.stringify(`${extractLoginScript(source.normalizedSource.loginUrl)}\n${input.action}`)}, { result: ${JSON.stringify(input.form)}, book: null, chapter: null, isLongClick: false }); JSON.stringify({ result: __result, values: source.getLoginInfoMap() });`
          : `source.putLoginInfoMap(${JSON.stringify(input.form)}); source.login(); JSON.stringify({ values: source.getLoginInfoMap() });`
    const output = await evaluateLoginRule(ports.rules, source, code, signal)
    const payload = parseObject(output.value)
    const values = textMap(payload.values)
    const command = parseLoginActionCommand(payload.result)
    const nextState = command.state === undefined ? undefined : redactLoginValue(command.state)
    const nextUi = dynamic && command.state !== undefined && command.close !== true
      ? await evaluateLoginUi(ports.rules, source, session, staticFields, signal, command.state)
      : undefined
    return {
      sourceId: source.sourceId,
      fingerprint: source.fingerprint,
      values,
      ...(nextUi === undefined ? {} : { fields: nextUi.fields }),
      actions: nextUi === undefined ? output.actions : [...output.actions, ...(nextUi.actions ?? [])],
      ...(Object.prototype.hasOwnProperty.call(payload, 'result') ? { result: sanitizeLoginResult(payload.result) } : {}),
      ...(nextState === undefined ? {} : { state: nextState }),
      ...(command.errors === undefined ? {} : { errors: command.errors }),
      ...(command.close === undefined ? {} : { close: command.close }),
    }
  }))
}

async function evaluateLoginUi(rules: WorkflowRulePort, source: StoredSourceRecord, _session: SourceSession, staticFields: SourceLoginField[], signal?: AbortSignal, stateInput: unknown = {}): Promise<Omit<SourceLoginUi, 'sourceId' | 'fingerprint'>> {
  const dynamic = isLoginUiV2(source.normalizedSource.loginUi)
  const stateJson = JSON.stringify(stateInput)
  if (stateJson === undefined || stateJson.length > LOGIN_INPUT_LIMIT) throw new ReaderRuntimeError('invalid-input', '登录状态过大')
  const code = dynamic
    ? `JSON.stringify({ values: source.getLoginInfoMap(), state: ${JSON.stringify(stateJson)}, ui: source.evalLoginUiV2(${JSON.stringify(stateJson)}) })`
    : 'JSON.stringify({ values: source.getLoginInfoMap() })'
  const output = await evaluateLoginRule(rules, source, code, signal)
  const payload = parseObject(output.value)
  const values = textMap(payload.values)
  if (!dynamic) return { fields: staticFields.map((field) => ({ ...field, ...(isSensitiveField(field) || values[field.key ?? field.name] === undefined ? {} : { value: values[field.key ?? field.name] }) })), values, dynamic: false, actions: output.actions }
  return { fields: parseDynamicFields(payload.ui), values, dynamic: true, actions: output.actions, state: redactLoginValue(stateInput) }
}

async function evaluateLoginRule(rules: WorkflowRulePort, source: StoredSourceRecord, code: string, signal?: AbortSignal): Promise<{ value: unknown; actions: SourceLoginWorkflowAction[] }> {
  const actions: SourceLoginWorkflowAction[] = []
  const workflowActions: Readonly<Record<string, WorkflowAction>> = {
    upUiData: async () => { actions.push({ action: 'upUiData' }); return undefined },
    reUiView: async () => { actions.push({ action: 'reUiView' }); return undefined },
    refreshExplore: async () => { actions.push({ action: 'refreshExplore' }); return undefined },
    refreshBookInfo: async () => { actions.push({ action: 'refreshBookInfo' }); return undefined },
    refreshBookToc: async () => { actions.push({ action: 'refreshBookToc' }); return undefined },
    refreshContent: async () => { actions.push({ action: 'refreshContent' }); return undefined },
    reGetBook: async () => { actions.push({ action: 'reGetBook' }); return undefined },
    refreshTocUrl: async () => { actions.push({ action: 'refreshTocUrl' }); return undefined },
    copyText: async () => { actions.push({ action: 'copyText' }); return undefined },
    clearTtsCache: async () => { actions.push({ action: 'clearTtsCache' }); return undefined },
    searchBook: async () => { actions.push({ action: 'searchBook' }); return undefined },
    addBook: async () => { actions.push({ action: 'addBook' }); return undefined },
    showPhoto: async () => { actions.push({ action: 'showPhoto' }); return undefined },
    open: async () => { actions.push({ action: 'open' }); return undefined },
    saveInfoMap: async () => { actions.push({ action: 'saveInfoMap' }); return undefined },
  }
  const output = rules.executeWorkflowJavaScript === undefined
    ? await rules.evaluate({ source: source.normalizedSource, stage: 'search', field: 'loginUi', rule: `@js:${code}`, content: '', ...(signal === undefined ? {} : { signal }) })
    : await rules.executeWorkflowJavaScript({ source: source.normalizedSource, code, stage: 'search', workflowStage: 'search', workflowActions, ...(signal === undefined ? {} : { signal }) })
  if (output.status === 'capability-missing') throw new ReaderRuntimeError('configuration', output.message ?? '登录脚本需要宿主能力')
  if (output.status === 'cancelled') throw new ReaderRuntimeError('source-failed', output.message ?? '登录操作已取消')
  if (output.status !== 'success') throw new ReaderRuntimeError('source-failed', output.message ?? '登录脚本执行失败')
  const value = typeof output.value === 'string' ? output.value : JSON.stringify(output.value)
  if (value === undefined || value.length > LOGIN_RULE_LIMIT) throw new ReaderRuntimeError('source-failed', '登录脚本返回值无效')
  return { value, actions }
}

function parseStaticFields(value: unknown): SourceLoginField[] {
  let parsed: unknown = value
  if (typeof value === 'string') { try { parsed = JSON.parse(value) } catch { return [] } }
  return Array.isArray(parsed) ? parsed.flatMap((item) => sanitizeField(item)) : []
}

function parseDynamicFields(value: unknown): SourceLoginField[] {
  let parsed: unknown = value
  if (typeof value === 'string') { try { parsed = JSON.parse(value) } catch { throw new ReaderRuntimeError('source-failed', '登录 UI v2 返回了无效 JSON') } }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) parsed = (parsed as Record<string, unknown>).rows
  if (!Array.isArray(parsed)) throw new ReaderRuntimeError('source-failed', '登录 UI v2 必须返回 rows 数组')
  const fields = parsed.flatMap((item) => sanitizeField(item))
  if (fields.length === 0 || fields.length !== parsed.length) throw new ReaderRuntimeError('source-failed', '登录 UI v2 返回了无效控件')
  const valueFields = fields.filter((field) => ['text', 'password', 'select', 'toggle'].includes(field.type))
  const keys = valueFields.map((field) => field.key ?? '')
  if (valueFields.some((field) => (field.key ?? '').trim().length === 0) || keys.length !== new Set(keys).size) throw new ReaderRuntimeError('source-failed', '登录 UI v2 控件 key 无效或重复')
  const actionFields = fields.filter((field) => field.type === 'button' || field.type === 'toggle')
  const actions = actionFields.map((field) => field.action ?? '')
  if (actionFields.some((field) => (field.action ?? '').trim().length === 0) || actions.length !== new Set(actions).size) throw new ReaderRuntimeError('source-failed', '登录 UI v2 控件 action 无效或重复')
  if (fields.some((field) => !['text', 'password', 'button', 'label', 'toggle', 'select'].includes(field.type))) throw new ReaderRuntimeError('source-failed', '登录 UI v2 控件类型不受支持')
  if (fields.some((field) => field.type === 'select' && (field.options ?? []).length === 0)) throw new ReaderRuntimeError('source-failed', '登录 UI v2 select 缺少 options')
  return fields
}

function sanitizeField(value: unknown): SourceLoginField[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const item = value as Record<string, unknown>
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  if (name.length === 0 || name.length > 256) return []
  const type = typeof item.type === 'string' ? item.type : 'text'
  const field: SourceLoginField = { name, type }
  for (const key of ['hint', 'key', 'action'] as const) if (typeof item[key] === 'string') field[key] = (item[key] as string).trim()
  if (!isSensitiveField(field)) {
    if (typeof item.default === 'string') field.default = item.default
    if (typeof item.value === 'string') field.value = item.value
  }
  if (Array.isArray(item.chars)) field.chars = item.chars.map((entry) => entry === null || typeof entry === 'string' ? entry : String(entry))
  if (Array.isArray(item.options)) field.options = item.options.map((entry) => String(entry)).slice(0, 256)
  if (Number.isSafeInteger(item.countdown)) field.countdown = Number(item.countdown)
  return [field]
}

function isLoginUiV2(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try { const parsed: unknown = JSON.parse(value); return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Number((parsed as Record<string, unknown>).version) === 2 } catch { return false }
}

function extractLoginScript(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  const match = /^(?:<js>([\s\S]*?)<\/js>|@js:([\s\S]*))$/iu.exec(text)
  return (match?.[1] ?? match?.[2] ?? text).trim()
}

function isOpenableAction(value: string): boolean {
  return /^(?:https?|file|about|data):/iu.test(value.trim())
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') { try { const parsed: unknown = JSON.parse(value); return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} } catch { return {} } }
  return {}
}

function textMap(value: unknown): Record<string, string> {
  const parsed = parseObject(value)
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => key.length <= 256 && !isSensitiveLoginKey(key)).map(([key, item]) => [key, toText(redactLoginValue(item))]))
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return JSON.stringify(value) ?? ''
}

function sanitizeLoginResult(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed !== null && typeof parsed === 'object') return sanitizeLoginResult(parsed)
    } catch { /* loginAction may intentionally return a plain message or URL. */ }
    return value
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 128).map(sanitizeLoginResult)
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 128).map(([key, item]) => [key, isSensitiveLoginKey(key) ? '[redacted]' : sanitizeLoginResult(item)]))
  return String(value)
}

function parseLoginActionCommand(value: unknown): { state?: unknown; errors?: Record<string, string>; close?: boolean } {
  const parsed = typeof value === 'string' ? parseObject(value) : value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  if (parsed === undefined) return {}
  const rawErrors = parsed.error ?? parsed.errors
  const errors = rawErrors === undefined ? undefined : parseObject(rawErrors)
  return {
    ...(parsed.state !== undefined && parsed.state !== null && typeof parsed.state === 'object' && !Array.isArray(parsed.state) ? { state: parsed.state } : {}),
    ...(errors === undefined
      ? {}
      : { errors: Object.fromEntries(Object.entries(errors).filter(([key, item]) => key.length <= 256 && typeof item === 'string').map(([key, item]) => [key, isSensitiveLoginKey(key) ? '[redacted]' : item as string])) }),
    ...(typeof parsed.close === 'boolean' ? { close: parsed.close } : {}),
  }
}

function isSensitiveField(field: Pick<SourceLoginField, 'name' | 'type' | 'key'>): boolean {
  return field.type === 'password' || isSensitiveLoginKey(field.name) || (field.key !== undefined && isSensitiveLoginKey(field.key))
}

function isSensitiveLoginKey(key: string): boolean {
  const normalized = key.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`).toLowerCase()
  return /(?:^|[_-])(?:pass|password|passcode|passwd|pwd|token|secret|cookie|authorization|credential|api(?:[_-]?key)?|access(?:[_-]?token)?|refresh(?:[_-]?token)?|session(?:[_-]?id)?|sid|otp|captcha|verification|verify(?:code)?|auth(?:entication)?(?:code|token)?)(?=$|[_-]|\d)/.test(normalized)
}

function redactLoginValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 128).map(redactLoginValue)
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 128).map(([key, item]) => [key, isSensitiveLoginKey(key) ? '[redacted]' : redactLoginValue(item)]))
}
