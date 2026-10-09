import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AuthCard, EmailPasswordFields } from '../components/auth-form.tsx'
import { signIn } from '../lib/auth.ts'

export function LoginPage() {
  const navigate = useNavigate(); const location = useLocation()
  const target = (location.state as { from?: string } | null)?.from ?? '/'
  return <AuthCard title="登录" footer={<span>还没有账号？ <Link className="link" to="/register">注册</Link> · <Link className="link" to="/forgot-password">忘记密码</Link></span>}>
    <EmailPasswordFields submitLabel="登录" onSubmit={async ({ email, password }) => { await signIn(email, password); await navigate(target, { replace: true }) }} />
  </AuthCard>
}
