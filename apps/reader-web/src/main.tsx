import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthProvider } from './lib/auth-context.tsx'
import { AppRouter } from './router.tsx'
import './styles.css'

createRoot(document.getElementById('root')!).render(<StrictMode><AuthProvider><AppRouter /></AuthProvider></StrictMode>)
