import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { AuthCard } from '../components/auth-form.tsx'
import { clearCallbackUrl, safeNext, verifyCallback } from '../lib/auth.ts'

export function AuthConfirmPage() {
  const navigate = useNavigate(); const [params] = useSearchParams(); const [error, setError] = useState<string>(); const [message, setMessage] = useState('正在验证链接…')
  useEffect(() => { let active = true; let timer: number | undefined; const tokenHash = params.get('token_hash') ?? undefined; const code = params.get('code') ?? undefined; const type = params.get('type') ?? 'email'; const next = safeNext(params.get('redirect_to') ?? params.get('next')); if (tokenHash === undefined && code === undefined) { setError('验证链接缺少凭证'); return }; clearCallbackUrl(); void verifyCallback({ ...(tokenHash === undefined ? {} : { tokenHash }), ...(code === undefined ? {} : { code }), type }).then((verified) => { if (!active) return; if (verified === 'recovery') void navigate('/reset-password', { replace: true }); else { setMessage('邮箱验证成功，正在进入阅读器…'); timer = window.setTimeout(() => void navigate(next, { replace: true }), 500) } }, (reason) => { if (active) setError(reason instanceof Error ? reason.message : '验证失败') }); return () => { active = false; if (timer !== undefined) window.clearTimeout(timer) } }, [navigate, params])
  return <AuthCard title="邮箱验证">{error === undefined ? <p className="success" role="status">{message}</p> : <><p className="error" role="alert">{error}</p><Link className="link" to="/forgot-password">重新发送密码恢复邮件</Link></>}</AuthCard>
}
