import { DismissibleMessage } from '../components/dismissible-message.tsx'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AuthCard, AuthResult, PasswordField } from '../components/auth-form.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { resendConfirmation, signUp } from '../lib/auth.ts'

export function RegisterPage() {
  const navigate = useNavigate(); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState(''); const [sent, setSent] = useState(false); const [resendMessage, setResendMessage] = useState<string>(); const [error, setError] = useState<string>(); const [pending, setPending] = useState(false); const [resending, setResending] = useState(false)
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setError(undefined); setResendMessage(undefined); if (password !== confirmation) { setError('两次输入的密码不一致'); return }; setPending(true); try { const result = await signUp(email, password); if (result.needsConfirmation) setSent(true); else await navigate('/', { replace: true }) } catch (reason) { setError(reason instanceof Error ? reason.message : '注册失败') } finally { setPending(false) } }
  const resend = async () => { setError(undefined); setResendMessage(undefined); setResending(true); try { await resendConfirmation(email); setResendMessage('验证邮件已重新发送，请检查收件箱。') } catch (reason) { setError(reason instanceof Error ? reason.message : '验证邮件发送失败') } finally { setResending(false) } }
  return <AuthCard title="创建账号" description="使用邮箱创建你的页灯账号" footer={<span>已有账号？ <Link className="link" to="/login">登录</Link></span>}>
    {sent ? <AuthResult title="请验证邮箱" actions={<><Button disabled={resending} type="button" onClick={() => void resend()}>{resending ? '发送中…' : '重新发送'}</Button><Link className="auth-result-link" to="/login">返回登录</Link></>}>
      <p>我们已将验证邮件发送到 <strong className="auth-result-email">{email}</strong>。</p>
      <p className="muted">点击邮件中的链接完成注册。没有收到邮件时，请检查垃圾邮件。</p>
      {resendMessage === undefined ? null : <DismissibleMessage onDismiss={() => setResendMessage(undefined)} className="success" role="status">{resendMessage}</DismissibleMessage>}
      {error === undefined ? null : <DismissibleMessage onDismiss={() => setError(undefined)} className="error" role="alert">{error}</DismissibleMessage>}
    </AuthResult> : <form className="form auth-form" onSubmit={(event) => void submit(event)}>
      <div className="field"><label htmlFor="email">邮箱</label><Input id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></div>
      <PasswordField id="password" label="密码" autoComplete="new-password" minLength={8} required value={password} onChange={setPassword} hint="至少 8 位字符" />
      <PasswordField id="confirmation" label="确认密码" autoComplete="new-password" minLength={8} required value={confirmation} onChange={setConfirmation} />
      {error === undefined ? null : <DismissibleMessage onDismiss={() => setError(undefined)} className="error" role="alert">{error}</DismissibleMessage>}
      <Button className="auth-submit" disabled={pending} type="submit">{pending ? '创建中…' : '创建账号'}</Button>
    </form>}
  </AuthCard>
}
