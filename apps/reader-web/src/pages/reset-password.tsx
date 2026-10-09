import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AuthCard } from '../components/auth-form.tsx'
import { signOut, updatePassword } from '../lib/auth.ts'

export function ResetPasswordPage() {
  const navigate = useNavigate(); const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState(''); const [error, setError] = useState<string>(); const [pending, setPending] = useState(false)
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setError(undefined); if (password !== confirmation) { setError('两次输入的密码不一致'); return }; setPending(true); try { await updatePassword(password); await signOut().catch(() => undefined); await navigate('/login', { replace: true }) } catch (reason) { setError(reason instanceof Error ? reason.message : '密码更新失败') } finally { setPending(false) } }
  return <AuthCard title="设置新密码" footer={<Link className="link" to="/login">返回登录</Link>}><form className="form" onSubmit={(event) => void submit(event)}><div className="field"><label htmlFor="password">新密码</label><input id="password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} /></div><div className="field"><label htmlFor="confirmation">确认密码</label><input id="confirmation" type="password" autoComplete="new-password" minLength={8} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></div>{error === undefined ? null : <p className="error" role="alert">{error}</p>}<button className="button" disabled={pending} type="submit">{pending ? '保存中…' : '保存新密码'}</button></form></AuthCard>
}
