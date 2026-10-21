import { useState, type FormEvent, type ReactNode } from 'react'
import { PageHeader } from './page-header.tsx'
import { Button } from './ui/button.tsx'
import { Card } from './ui/card.tsx'
import { Input } from './ui/input.tsx'

export function AuthCard({ title, children, footer, backTo, embedded = false }: { title: string; children: ReactNode; footer?: ReactNode; backTo?: string; /** 已有页面布局时仅渲染卡片，避免重复安全区和顶部留白。 */ embedded?: boolean }) {
  const card = <Card><PageHeader title={title} {...(backTo === undefined ? {} : { backTo })} />{children}{footer === undefined ? null : <div className="muted" style={{ marginTop: '1.25rem' }}>{footer}</div>}</Card>
  return embedded ? card : <div className="app-shell"><main className="app-main app-main-standalone">{card}</main></div>
}

export function EmailPasswordFields({ submitLabel, onSubmit, includeCurrent = false }: { submitLabel: string; onSubmit: (values: { email: string; password: string; currentPassword?: string }) => Promise<void>; includeCurrent?: boolean }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(undefined); setPending(true); try { await onSubmit({ email, password, ...(includeCurrent ? { currentPassword } : {}) }) } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败') } finally { setPending(false) } }
  return <form className="form" onSubmit={(event) => void submit(event)}>
    {includeCurrent ? <div className="field"><label htmlFor="current-password">当前密码</label><Input id="current-password" type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></div> : null}
    <div className="field"><label htmlFor="email">邮箱</label><Input id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></div>
    <div className="field"><label htmlFor="password">{includeCurrent ? '新密码' : '密码'}</label><Input id="password" type="password" autoComplete={includeCurrent ? 'new-password' : 'current-password'} minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} /></div>
    {error === undefined ? null : <p className="error" role="alert">{error}</p>}
    <Button disabled={pending} type="submit">{pending ? '处理中…' : submitLabel}</Button>
  </form>
}
