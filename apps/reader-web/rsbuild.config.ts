import { defineConfig } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss'

export default defineConfig({
  plugins: [pluginReact(), pluginTailwindcss()],
  source: {
    entry: { index: './src/main.tsx' },
    define: {
      'process.env.PUBLIC_SUPABASE_URL': JSON.stringify(process.env.PUBLIC_SUPABASE_URL ?? ''),
      'process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? ''),
    },
  },
  html: { template: './public/index.html' },
  output: {
    distPath: { root: './dist' },
    sourceMap: { js: false, css: false },
  },
  server: {
    port: 3000,
    proxy: { '/api': 'http://localhost:8787' },
  },
})
