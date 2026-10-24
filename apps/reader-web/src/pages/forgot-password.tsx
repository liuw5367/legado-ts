import { DismissibleMessage } from '../components/dismissible-message.tsx'
import { useState } from 'react'
import { AuthCard, AuthResult } from '../components/auth-form.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { requestPasswordReset } from '../lib/auth.ts'

export function ForgotPasswordPage() {
  const [email, setEmail] = useState(''); const [sent, setSent] = useState(false); const [resendMessage, setResendMessage] = useState<string>(); const [error, setError] = useState<string>(); const [pending, setPending] = useState(false)
  const submit = async (event?: React.FormEvent) => { event?.preventDefault(); setError(undefined); setResendMessage(undefined); setPending(true); try { await requestPasswordReset(email); setSent(true); if (event === undefined) setResendMessage('恢复邮件已重新发送，请检查收件箱。') } catch (reason) { setError(reason instanceof Error ? reason.message : '发送失败') } finally { setPending(false) } }
  return <AuthCard title="忘记密码" backTo="/login">
    {sent ? <AuthResult title="查看恢复邮件" actions={<><Button disabled={pending} type="button" onClick={() => void submit()}>{pending ? '发送中…' : '重新发送'}</Button><button className="auth-result-link" type="button" onClick={() => { setSent(false); setResendMessage(undefined); setError(undefined) }}>邮箱填错了？修改邮箱</button></>}>
      <p>如果该邮箱已注册，恢复邮件会很快送达：</p>
      <p className="auth-result-email">{email}</p>
      <p className="muted">请检查收件箱和垃圾邮件，点击邮件中的链接设置新密码。</p>
      {resendMessage === undefined ? null : <DismissibleMessage onDismiss={() => setResendMessage(undefined)} className="success" role="status">{resendMessage}</DismissibleMessage>}
      {error === undefined ? null : <DismissibleMessage onDismiss={() => setError(undefined)} className="error" role="alert">{error}</DismissibleMessage>}
    </AuthResult> : <form className="form auth-form" onSubmit={(event) => void submit(event)}>
      <p className="auth-form-intro muted">输入注册邮箱后，我们会发送密码恢复链接。</p>
      <div className="field"><label htmlFor="email">邮箱</label><Input id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></div>
      {error === undefined ? null : <DismissibleMessage onDismiss={() => setError(undefined)} className="error" role="alert">{error}</DismissibleMessage>}
      <Button className="auth-submit" disabled={pending} type="submit">{pending ? '发送中…' : '发送恢复邮件'}</Button>
    </form>}
  </AuthCard>
}
