import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AuthCard } from '../components/auth-form.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { signOut, updatePassword } from '../lib/auth.ts'

export function ChangePasswordPage() {
  const navigate = useNavigate(); const [current, setCurrent] = useState(''); const [next, setNext] = useState(''); const [confirmation, setConfirmation] = useState(''); const [error, setError] = useState<string>(); const [pending, setPending] = useState(false)
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setError(undefined); if (next !== confirmation) { setError('两次输入的新密码不一致'); return }; setPending(true); try { await updatePassword(next, current); await signOut().catch(() => undefined); await navigate('/login', { replace: true }) } catch (reason) { setError(reason instanceof Error ? reason.message : '密码更新失败') } finally { setPending(false) } }
  return <AuthCard title="修改密码" footer={<Link className="link" to="/">返回首页</Link>}><form className="form" onSubmit={(event) => void submit(event)}><div className="field"><label htmlFor="current">当前密码</label><Input id="current" type="password" autoComplete="current-password" required value={current} onChange={(event) => setCurrent(event.target.value)} /></div><div className="field"><label htmlFor="next">新密码</label><Input id="next" type="password" autoComplete="new-password" minLength={8} required value={next} onChange={(event) => setNext(event.target.value)} /></div><div className="field"><label htmlFor="confirmation">确认新密码</label><Input id="confirmation" type="password" autoComplete="new-password" minLength={8} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></div>{error === undefined ? null : <p className="error" role="alert">{error}</p>}<Button disabled={pending} type="submit">{pending ? '保存中…' : '保存并重新登录'}</Button></form></AuthCard>
}
