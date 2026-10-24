import { DismissibleMessage } from '../components/dismissible-message.tsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { PageHeader } from '../components/page-header.tsx'
import { LoadingState } from '../components/loading-state.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Select } from '../components/ui/select.tsx'
import { apiFetch } from '../lib/api.ts'
import type { SourceLoginField, SourceLoginUi } from '../../shared/source-login.ts'

export function SourceLoginPage() {
  const { sourceId = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [ui, setUi] = useState<SourceLoginUi | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [state, setState] = useState<unknown>(undefined)
  const [countdowns, setCountdowns] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const actionTimers = useRef<Record<string, number>>({})
  const valuesRef = useRef<Record<string, string>>({})

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    const fingerprint = params.get('fingerprint')
    const query = fingerprint === null ? '' : `?fingerprint=${encodeURIComponent(fingerprint)}`
    void apiFetch<SourceLoginUi>(`/api/sources/${encodeURIComponent(sourceId)}/login/ui${query}`, { signal: controller.signal })
      .then((result) => { if (controller.signal.aborted) return; setUi(result); setValues(result.values); setState(result.state) })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取登录表单失败') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [params, sourceId])
  useEffect(() => { valuesRef.current = values }, [values])

  const fields = useMemo(() => ui?.fields ?? [], [ui?.fields])
  const countdownActive = Object.keys(countdowns).length > 0
  useEffect(() => {
    if (!countdownActive) return
    const timer = window.setInterval(() => setCountdowns((current) => Object.fromEntries(Object.entries(current).flatMap(([action, left]) => left > 1 ? [[action, left - 1]] : []))), 1000)
    return () => window.clearInterval(timer)
  }, [countdownActive])
  useEffect(() => () => Object.values(actionTimers.current).forEach((timer) => window.clearTimeout(timer)), [])
  function setValue(name: string, value: string) { setValues((current) => ({ ...current, [name]: value })) }
  function changeField(field: SourceLoginField, value: string) {
    const valueKey = field.key ?? field.name
    setValue(valueKey, value)
    if ((field.type === 'text' || field.type === 'password') && field.action !== undefined) {
      const oldTimer = actionTimers.current[valueKey]
      if (oldTimer !== undefined) window.clearTimeout(oldTimer)
      actionTimers.current[valueKey] = window.setTimeout(() => {
        delete actionTimers.current[valueKey]
        void submit(field.action, { [valueKey]: value })
      }, 600)
    }
  }
  async function submit(action?: string, formPatch?: Record<string, string>) {
    if (ui === null || pending || (action !== undefined && (countdowns[action] ?? 0) > 0)) return
    setPending(true); setError(''); setMessage('')
    const form = { ...valuesRef.current, ...formPatch }
    try {
      const result = await apiFetch<{ values: Record<string, string>; fields?: SourceLoginField[]; state?: unknown; errors?: Record<string, string>; close?: boolean; result?: unknown }>('/api/sources/' + encodeURIComponent(sourceId) + '/login/action', { method: 'POST', body: JSON.stringify({ sourceId, fingerprint: ui.fingerprint, action, state, form }) })
      setValues((current) => ({ ...current, ...result.values }))
      if (result.state !== undefined) setState(result.state)
      const nextFields = result.fields
      if (nextFields !== undefined) setUi((current) => current === null ? null : { ...current, fields: nextFields, ...(result.state === undefined ? {} : { state: result.state }) })
      if (result.close === true) { navigate('/sources'); return }
      if (typeof result.result === 'string' && /^(?:https?|file|about|data):/iu.test(result.result)) window.open(result.result, '_blank', 'noopener,noreferrer')
      const errorCount = Object.keys(result.errors ?? {}).length
      const actionField = action === undefined ? undefined : fields.find((field) => field.type === 'button' && field.action === action)
      if (errorCount === 0 && action !== undefined && actionField?.countdown !== undefined && actionField.countdown > 0) setCountdowns((current) => ({ ...current, [action]: actionField.countdown! }))
      setMessage(errorCount > 0 ? `登录脚本返回 ${errorCount} 个字段错误。` : '登录脚本已执行，后续请求会使用新的登录状态。')
    } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : '登录失败') }
    finally { setPending(false) }
  }

  return <section className="page-stack page-narrow source-login-page">
    <PageHeader backTo="/sources" title="书源登录" description={ui?.dynamic === true ? '动态登录表单' : '书源登录信息'} />
    {loading ? <LoadingState message="正在读取登录表单…" variant="content" /> : null}
    {error.length > 0 ? <DismissibleMessage onDismiss={() => setError('')} className="error" role="alert">{error}<Button variant="secondary" size="sm" onClick={() => navigate(0)}>重试</Button></DismissibleMessage> : null}
    {!loading && ui !== null && fields.length === 0 && error.length === 0 ? <div className="empty-state"><p>此书源没有可用的非浏览器登录表单。</p><p className="muted small">需要 WebView、验证码或外部浏览器的登录流程会明确返回能力缺失。</p></div> : null}
    {!loading && ui !== null && fields.length > 0 ? <form className="form" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      {fields.map((field) => { const valueKey = field.key ?? field.name; const action = field.action; const countdown = action === undefined ? undefined : countdowns[action]; return <LoginField key={valueKey} field={field} value={values[valueKey] ?? field.value ?? field.default ?? ''} disabled={pending || (countdown ?? 0) > 0} {...(countdown === undefined ? {} : { countdown })} onChange={(value) => changeField(field, value)} onAction={(nextAction, value) => void submit(nextAction, value === undefined ? undefined : { [valueKey]: value })} /> })}
      {message.length > 0 ? <DismissibleMessage onDismiss={() => setMessage('')} className="success" role="status">{message}</DismissibleMessage> : null}
      <Button type="submit" disabled={pending}>{pending ? '提交中…' : '提交登录'}</Button>
    </form> : null}
  </section>
}

function LoginField({ field, value, disabled, countdown, onChange, onAction }: { field: SourceLoginField; value: string; disabled: boolean; countdown?: number; onChange: (value: string) => void; onAction: (action?: string, value?: string) => void }) {
  const valueKey = field.key ?? field.name
  if (field.type === 'button') return <Button type="button" variant="secondary" disabled={disabled} onClick={() => onAction(field.action)}>{countdown === undefined ? field.name : `${field.name} (${countdown}s)`}</Button>
  if (field.type === 'label') return <p className="muted">{field.name}</p>
  if (field.type === 'toggle' || field.type === 'select') {
    const options = (field.chars ?? field.options ?? []).filter((item): item is string => item !== null)
    return <label className="field"><span>{field.name}</span><Select name={valueKey} value={value} disabled={disabled} onChange={(event) => { const next = event.target.value; onChange(next); if (field.type === 'toggle' && field.action !== undefined) onAction(field.action, next) }}>{options.map((item) => <option key={item} value={item}>{item}</option>)}</Select></label>
  }
  return <label className="field"><span>{field.name}</span><Input name={valueKey} type={field.type === 'password' ? 'password' : 'text'} value={value} placeholder={field.hint} disabled={disabled} onChange={(event) => onChange(event.target.value)} /></label>
}
