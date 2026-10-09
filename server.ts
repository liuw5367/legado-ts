import readerApp from './apps/reader-web/server.ts'

// Vercel 的 Hono 适配器会扫描入口文件中的 `from 'hono'` 标记；实际路由由被导入的应用统一维护。
// 该应用的 server/app.ts 已直接导入 Hono，根入口不重复创建路由实例。
// import { Hono } from 'hono'

export default readerApp
