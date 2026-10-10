# reader-web 开发与部署

## 环境变量

本地将 `apps/reader-web/.env.example` 复制为 `.env.local`，或通过 `READER_WEB_ENV_FILE` 指定环境文件。浏览器构建使用 `PUBLIC_SUPABASE_URL` 和 `PUBLIC_SUPABASE_PUBLISHABLE_KEY`；服务端认证使用 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY` 和 `DATABASE_URL`。`SOURCE_RUNTIME_STATE_KEY` 只在服务端配置，使用至少 32 个字符的随机值，不能放进 `PUBLIC_*` 变量。

认证回调依赖 Supabase 的 Confirm signup、Reset password 模板。模板分别使用 `auth-email-templates/confirm-signup.html` 和 `auth-email-templates/reset-password.html`，将 `token_hash` 交给站内回调。生产环境配置 SMTP，并把部署域名加入 Site URL 和 Redirect URL 白名单。

## 本地启动

先准备数据库并执行迁移：

```bash
pnpm --filter @legado/reader-web db:migrate
```

再分别启动 API 和前端：

```bash
pnpm --filter @legado/reader-web dev:api
pnpm --filter @legado/reader-web dev
```

书籍来源缓存依赖 `0006_book_source_candidates.sql`，应先执行迁移再部署新版应用。迁移只新增表，旧版应用回滚可保留缓存表。

迁移是显式操作；开发和部署脚本不会在每次启动或构建时自动写数据库。

## 检查与构建

```bash
pnpm --filter @legado/reader-web typecheck
pnpm --filter @legado/reader-web build
pnpm --filter @legado/reader-web test
pnpm --filter @legado/reader-web test:db
pnpm run build:web:vercel
```

`test:db` 默认检查迁移文件。真实 PostgreSQL 集成测试需要显式设置 `READER_WEB_TEST_DATABASE_URL`，只使用独立测试数据库；它执行全部迁移并创建临时受限角色，以验证缓存 upsert、RLS 和认证 API，结束后删除角色。未设置时跳过该集成测试，不读取项目 DATABASE_URL。

`build:web:vercel` 生成根目录 `public/index.html` 与 `public/static/`，这些是构建产物，不手动提交。`vercel.json` 把 `/api/*` 交给 Hono，其余深链回退到 `index.html`。

## Vercel

Vercel Project Root 必须是仓库根目录。Preview 和 Production 都要配置公开 Supabase 变量、服务端 Supabase 变量、数据库连接和运行状态密钥。第一次部署前在目标 Supabase 数据库执行迁移；构建过程只生成前端和函数产物。

搜索流使用 SSE 和请求取消，当前搜索仍在函数请求生命周期内执行，并受应用和平台时限约束。需要超过函数时限的订阅刷新、持久检测或后台任务不能通过继续复用当前搜索接口解决，应按根目录 archive 中的 JobStore 目标单独设计。

## 安全边界

浏览器只拿 publishable key 和脱敏 DTO。数据库密码、服务端密钥、Cookie、脚本变量和运行状态密钥只能在 Hono/Repository/Node runtime 使用。书源导入仅接受 HTTP(S) 地址，并限制响应、候选、重定向和处理时长。日志、SSE 和错误消息不能回显 Authorization、Cookie、密码或完整私有请求体。

部署能力与共享 source-core 兼容性见 [运行边界](../../../docs/operations/runtime-security-and-deployment.md)；本文件只记录 reader-web 当前的本地和 Vercel 接入。
