import { DismissibleMessage } from '../components/dismissible-message.tsx'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AuthCard, PasswordField } from '../components/auth-form.tsx'
import { Button } from '../components/ui/button.tsx'
import { signOut, updatePassword } from '../lib/auth.ts'

export function ResetPasswordPage() {
  const navigate = useNavigate(); const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState(''); const [error, setError] = useState<string>(); const [pending, setPending] = useState(false)
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setError(undefined); if (password !== confirmation) { setError('两次输入的密码不一致'); return }; setPending(true); try { await updatePassword(password); await signOut().catch(() => undefined); await navigate('/login', { replace: true, state: { notice: '密码已更新，请重新登录。' } }) } catch (reason) { setError(reason instanceof Error ? reason.message : '密码更新失败') } finally { setPending(false) } }
  return <AuthCard title="设置新密码" description="为你的账号设置一个新的登录密码。" backTo="/login"><form className="form auth-form" onSubmit={(event) => void submit(event)}><PasswordField id="password" label="新密码" autoComplete="new-password" minLength={8} required value={password} onChange={setPassword} hint="至少 8 位字符" /><PasswordField id="confirmation" label="确认密码" autoComplete="new-password" minLength={8} required value={confirmation} onChange={setConfirmation} />{error === undefined ? null : <DismissibleMessage onDismiss={() => setError(undefined)} className="error" role="alert">{error}</DismissibleMessage>}<Button className="auth-submit" disabled={pending} type="submit">{pending ? '保存中…' : '保存新密码'}</Button></form></AuthCard>
}
