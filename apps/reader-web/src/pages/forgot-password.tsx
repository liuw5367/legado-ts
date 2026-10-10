import { useState } from 'react'
import { AuthCard } from '../components/auth-form.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { requestPasswordReset } from '../lib/auth.ts'

export function ForgotPasswordPage() {
  const [email, setEmail] = useState(''); const [sent, setSent] = useState(false); const [error, setError] = useState<string>(); const [pending, setPending] = useState(false)
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setError(undefined); setPending(true); try { await requestPasswordReset(email); setSent(true) } catch (reason) { setError(reason instanceof Error ? reason.message : '发送失败') } finally { setPending(false) } }
  return <AuthCard title="忘记密码" backTo="/login">
    <form className="form" onSubmit={(event) => void submit(event)}>
      <p className="muted">输入注册邮箱后，我们会发送密码恢复链接。</p>
      <div className="field"><label htmlFor="email">邮箱</label><Input id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></div>
      {sent ? <p className="success" role="status">如果该邮箱已注册，恢复邮件会很快送达。请检查收件箱和垃圾邮件。</p> : null}
      {error === undefined ? null : <p className="error" role="alert">{error}</p>}
      <Button disabled={pending} type="submit">{pending ? '发送中…' : '发送恢复邮件'}</Button>
    </form>
  </AuthCard>
}
