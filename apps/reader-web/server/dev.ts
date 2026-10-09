import { serve } from '@hono/node-server'
import app from './app.ts'

const port = Number.parseInt(process.env.PORT ?? '8787', 10)
serve({ fetch: app.fetch, port })
console.log(`reader-web API listening on ${port}`)
