import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AuthCard } from '../components/auth-form.tsx'
import { resendConfirmation, signUp } from '../lib/auth.ts'

export function RegisterPage() {
  const navigate = useNavigate(); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState(''); const [message, setMessage] = useState<string>(); const [error, setError] = useState<string>(); const [pending, setPending] = useState(false); const [resending, setResending] = useState(false)
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setError(undefined); if (password !== confirmation) { setError('两次输入的密码不一致'); return }; setPending(true); try { const result = await signUp(email, password); if (result.needsConfirmation) setMessage('注册成功。请查收验证邮件，验证邮箱后再登录。'); else await navigate('/', { replace: true }) } catch (reason) { setError(reason instanceof Error ? reason.message : '注册失败') } finally { setPending(false) } }
  const resend = async () => { setError(undefined); setResending(true); try { await resendConfirmation(email); setMessage('验证邮件已重新发送，请检查收件箱。') } catch (reason) { setError(reason instanceof Error ? reason.message : '验证邮件发送失败') } finally { setResending(false) } }
  return <AuthCard title="注册" footer={<span>已有账号？ <Link className="link" to="/login">返回登录</Link></span>}>
    <form className="form" onSubmit={(event) => void submit(event)}>
      <div className="field"><label htmlFor="email">邮箱</label><input id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></div>
      <div className="field"><label htmlFor="password">密码</label><input id="password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} /></div>
      <div className="field"><label htmlFor="confirmation">确认密码</label><input id="confirmation" type="password" autoComplete="new-password" minLength={8} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></div>
      {message === undefined ? null : <p className="success" role="status">{message} <button className="link" disabled={resending} type="button" onClick={() => void resend()}>{resending ? '发送中…' : '重新发送'}</button></p>}
      {error === undefined ? null : <p className="error" role="alert">{error}</p>}
      <button className="button" disabled={pending} type="submit">{pending ? '注册中…' : '注册'}</button>
    </form>
  </AuthCard>
}
