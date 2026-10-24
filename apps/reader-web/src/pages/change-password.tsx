import { DismissibleMessage } from '../components/dismissible-message.tsx'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AuthCard, PasswordField } from '../components/auth-form.tsx'
import { Button } from '../components/ui/button.tsx'
import { signOut, updatePassword } from '../lib/auth.ts'

export function ChangePasswordPage() {
  const navigate = useNavigate(); const [current, setCurrent] = useState(''); const [next, setNext] = useState(''); const [confirmation, setConfirmation] = useState(''); const [error, setError] = useState<string>(); const [pending, setPending] = useState(false)
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setError(undefined); if (next !== confirmation) { setError('两次输入的新密码不一致'); return }; setPending(true); try { await updatePassword(next, current); await signOut().catch(() => undefined); await navigate('/login', { replace: true, state: { notice: '密码已更新，请重新登录。' } }) } catch (reason) { setError(reason instanceof Error ? reason.message : '密码更新失败') } finally { setPending(false) } }
  return <AuthCard embedded title="修改密码" description="修改后需要重新登录。" backTo="/account/settings"><form className="form auth-form" onSubmit={(event) => void submit(event)}><PasswordField id="current" label="当前密码" autoComplete="current-password" required value={current} onChange={setCurrent} /><PasswordField id="next" label="新密码" autoComplete="new-password" minLength={8} required value={next} onChange={setNext} hint="至少 8 位字符" /><PasswordField id="confirmation" label="确认新密码" autoComplete="new-password" minLength={8} required value={confirmation} onChange={setConfirmation} />{error === undefined ? null : <DismissibleMessage onDismiss={() => setError(undefined)} className="error" role="alert">{error}</DismissibleMessage>}<Button className="auth-submit" disabled={pending} type="submit">{pending ? '保存中…' : '保存并重新登录'}</Button></form></AuthCard>
}
