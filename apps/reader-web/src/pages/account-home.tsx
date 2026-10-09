import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth-context.tsx'

export function AccountHomePage() {
  const { user } = useAuth()
  return <section className="card"><h1>欢迎回来</h1><p>当前账号：{user?.email}</p><p className="muted">阅读器业务页面将在后续任务接入。</p><div className="actions"><Link className="button" to="/account/password">修改密码</Link></div></section>
}
