import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import app from '../server/app.ts'

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url))
const pwaDirectory = fileURLToPath(new URL('../public/static/pwa/', import.meta.url))

test('PWA manifest declares the installable reader entry and safe icons', async () => {
  const source = await readFile(`${pwaDirectory}/manifest.webmanifest`, 'utf8')
  const manifest = JSON.parse(source) as {
    name?: string
    short_name?: string
    start_url?: string
    scope?: string
    display?: string
    background_color?: string
    theme_color?: string
    icons?: Array<{ src?: string; sizes?: string; type?: string; purpose?: string }>
  }
  assert.equal(manifest.name, 'Legado Reader')
  assert.equal(manifest.short_name, '阅读')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.scope, '/')
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.background_color, '#f6f3ed')
  assert.equal(manifest.theme_color, '#f6f3ed')
  assert.deepEqual(manifest.icons, [
    { src: '/static/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/static/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/static/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ])
})

test('PWA HTML metadata and PNG assets are present with expected dimensions', async () => {
  const html = await readFile(`${publicDirectory}/index.html`, 'utf8')
  assert.match(html, /rel="manifest" href="\/static\/pwa\/manifest\.webmanifest"/u)
  assert.match(html, /rel="icon" type="image\/png" sizes="32x32" href="\/static\/pwa\/favicon-32\.png"/u)
  assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\/static\/pwa\/apple-touch-icon\.png"/u)
  assert.match(html, /name="theme-color" content="#f6f3ed"/u)

  for (const [file, width, height] of [['icon-192.png', 192, 192], ['icon-512.png', 512, 512], ['apple-touch-icon.png', 180, 180], ['favicon-32.png', 32, 32]] as const) {
    const png = await readFile(`${pwaDirectory}/${file}`)
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(png.readUInt32BE(16), width)
    assert.equal(png.readUInt32BE(20), height)
  }
})

test('PWA static endpoint returns its MIME and revalidation policy', async () => {
  const manifest = await app.request('http://localhost/static/pwa/manifest.webmanifest')
  assert.equal(manifest.status, 200)
  assert.equal(manifest.headers.get('content-type'), 'application/manifest+json; charset=utf-8')
  assert.equal(manifest.headers.get('cache-control'), 'no-cache')
  assert.match(await manifest.text(), /"short_name": "阅读"/u)

  const icon = await app.request('http://localhost/static/pwa/icon-192.png')
  assert.equal(icon.status, 200)
  assert.equal(icon.headers.get('content-type'), 'image/png')
  assert.equal(icon.headers.get('cache-control'), 'no-cache')
  assert.equal((await icon.arrayBuffer()).byteLength > 0, true)

  const head = await app.request('http://localhost/static/pwa/icon-192.png', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal((await head.arrayBuffer()).byteLength, 0)

  const missing = await app.request('http://localhost/static/pwa/missing.png')
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get('content-type')?.startsWith('text/html'), false)
})
