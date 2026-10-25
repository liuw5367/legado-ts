import { DismissibleMessage } from '../components/dismissible-message.tsx'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AuthCard, EmailPasswordFields } from '../components/auth-form.tsx'
import { signIn } from '../lib/auth.ts'

export function LoginPage() {
  const navigate = useNavigate(); const location = useLocation()
  const state = location.state as { from?: string; notice?: string } | null
  const target = state?.from ?? '/'
  return <AuthCard title="登录" description="登录你的页灯账号" footer={<span>还没有账号？ <Link className="link" to="/register">创建账号</Link></span>}>
    {state?.notice === undefined ? null : <DismissibleMessage className="success auth-inline-message" role="status">{state.notice}</DismissibleMessage>}
    <EmailPasswordFields submitLabel="登录" passwordAside={<Link className="link auth-field-link" to="/forgot-password">忘记密码？</Link>} onSubmit={async ({ email, password }) => { await signIn(email, password); await navigate(target, { replace: true }) }} />
  </AuthCard>
}
