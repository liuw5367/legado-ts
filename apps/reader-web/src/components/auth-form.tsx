import { APP_NAME, APP_TAGLINE } from '../lib/app-config.ts'
import { DismissibleMessage } from './dismissible-message.tsx'
import { Eye, EyeOff } from 'lucide-react'
import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react'
import { PageHeader } from './page-header.tsx'
import { Button } from './ui/button.tsx'
import { Card } from './ui/card.tsx'
import { Input } from './ui/input.tsx'

export function AuthCard({ title, description, children, footer, backTo, embedded = false }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode; backTo?: string; /** 已有页面布局时仅渲染卡片，避免重复安全区和顶部留白。 */ embedded?: boolean }) {
  const card = <Card className={`auth-card${embedded ? ' auth-card-embedded' : ''}`}><PageHeader title={title} description={description} {...(backTo === undefined ? {} : { backTo })} />{children}{footer === undefined ? null : <div className="auth-footer muted">{footer}</div>}</Card>
  if (embedded) return card
  return <div className="auth-shell"><div className="auth-frame"><div className="auth-brand"><img className="auth-brand-mark" src="/static/pwa/icon-192.png" alt="" width="36" height="36" /><div className="auth-brand-copy"><strong>{APP_NAME}</strong><span>{APP_TAGLINE}</span></div></div>{card}</div></div>
}

export function PasswordField({ id, label, value, onChange, hint, aside, ...inputProps }: { id: string; label: string; value: string; onChange: (value: string) => void; hint?: ReactNode; aside?: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type' | 'value' | 'onChange'>) {
  const [visible, setVisible] = useState(false)
  const hintId = hint === undefined ? undefined : `${id}-hint`
  return <div className="field">
    <div className="field-label-row"><label htmlFor={id}>{label}</label>{aside}</div>
    <div className="password-control">
      <Input {...inputProps} id={id} type={visible ? 'text' : 'password'} value={value} onChange={(event) => onChange(event.target.value)} aria-describedby={hintId} />
      <button className="password-toggle" type="button" aria-label={visible ? `隐藏${label}` : `显示${label}`} onClick={() => setVisible((current) => !current)}>
        {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        <span>{visible ? '隐藏' : '显示'}</span>
      </button>
    </div>
    {hint === undefined ? null : <p className="field-hint" id={hintId}>{hint}</p>}
  </div>
}

export function AuthResult({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return <section className="auth-result" aria-live="polite">
    <div className="auth-result-mark" aria-hidden="true">✓</div>
    <h2>{title}</h2>
    <div className="auth-result-copy">{children}</div>
    {actions === undefined ? null : <div className="auth-result-actions">{actions}</div>}
  </section>
}

export function EmailPasswordFields({ submitLabel, onSubmit, includeCurrent = false, passwordAside }: { submitLabel: string; onSubmit: (values: { email: string; password: string; currentPassword?: string }) => Promise<void>; includeCurrent?: boolean; passwordAside?: ReactNode }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(undefined); setPending(true); try { await onSubmit({ email, password, ...(includeCurrent ? { currentPassword } : {}) }) } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败') } finally { setPending(false) } }
  return <form className="form auth-form" onSubmit={(event) => void submit(event)}>
    {includeCurrent ? <PasswordField id="current-password" label="当前密码" autoComplete="current-password" required value={currentPassword} onChange={setCurrentPassword} /> : null}
    <div className="field"><label htmlFor="email">邮箱</label><Input id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></div>
    <PasswordField id="password" label={includeCurrent ? '新密码' : '密码'} autoComplete={includeCurrent ? 'new-password' : 'current-password'} minLength={8} required value={password} onChange={setPassword} aside={passwordAside} />
    {error === undefined ? null : <DismissibleMessage onDismiss={() => setError(undefined)} className="error" role="alert">{error}</DismissibleMessage>}
    <Button className="auth-submit" disabled={pending} type="submit">{pending ? '处理中…' : submitLabel}</Button>
  </form>
}
