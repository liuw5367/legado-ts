import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthProvider } from './lib/auth-context.tsx'
import { ReaderSettingsProvider } from './lib/settings-context.tsx'
import { BookCacheProvider } from './lib/book-cache-context.tsx'
import { AppRouter } from './router.tsx'
import './styles.css'

createRoot(document.getElementById('root')!).render(<StrictMode><AuthProvider><ReaderSettingsProvider><BookCacheProvider><AppRouter /></BookCacheProvider></ReaderSettingsProvider></AuthProvider></StrictMode>)
