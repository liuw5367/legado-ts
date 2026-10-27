# reader-web 开发与部署

## 环境变量

本地将 `apps/reader-web/.env.example` 复制为 `.env.local`，或通过 `READER_WEB_ENV_FILE` 指定环境文件。浏览器构建使用 `PUBLIC_SUPABASE_URL` 和 `PUBLIC_SUPABASE_PUBLISHABLE_KEY`；服务端认证使用 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY` 和 `DATABASE_URL`。`SOURCE_RUNTIME_STATE_KEY` 只在服务端配置，使用至少 32 个字符的随机值，不能放进 `PUBLIC_*` 变量。

| 变量 | 读取位置 | 用途 |
| --- | --- | --- |
| `PUBLIC_SUPABASE_URL` | 浏览器构建 | Supabase 项目 URL |
| `PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 浏览器构建 | 浏览器端 Supabase publishable key |
| `SUPABASE_URL` | Hono 服务端 | 校验登录令牌的 Supabase URL |
| `SUPABASE_PUBLISHABLE_KEY` | Hono 服务端 | 服务端 Supabase 客户端使用的 publishable key |
| `DATABASE_URL` | Hono、Drizzle 迁移和测试 | PostgreSQL 连接串 |
| `SOURCE_RUNTIME_STATE_KEY` | Hono 服务端 | 加密每个用户的书源 Cookie 和脚本变量，至少 32 个字符 |
| `READER_WEB_ENV_FILE` | 开发脚本和测试 | 指定环境文件路径；未设置时读取 `apps/reader-web/.env.local` |

数据库密码、Cookie、脚本变量和 `SOURCE_RUNTIME_STATE_KEY` 不应放入 `PUBLIC_*` 变量或提交到仓库。

认证回调依赖 Supabase 的 Confirm signup、Reset password 模板。模板分别使用 `auth-email-templates/confirm-signup.html` 和 `auth-email-templates/reset-password.html`，将 `token_hash` 交给站内回调。生产环境配置 SMTP，并把部署域名加入 Site URL 和 Redirect URL 白名单。邮件模板品牌为“页灯”，图标从 `{{ .SiteURL }}/static/pwa/icon-192.png` 加载；修改仓库模板后需要在 Supabase 控制台同步模板，代码部署不会自动更新邮件模板。

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

书单和完整书架分组依赖 `0010_book_lists.sql`，新增两个表、书架可空分组列及 RLS。先迁移再部署；回滚应用代码可保留新增数据结构，不删除用户书单。

目录截断提示依赖 `0015_toc_truncated.sql` 新增的 `toc_snapshots.truncated` 列。先迁移再部署；旧快照默认 `false`，回滚应用代码可保留该列。

迁移是显式操作；开发和部署脚本不会在每次启动或构建时自动写数据库。

## 检查与构建

```bash
pnpm --filter @legado/reader-web typecheck
pnpm --filter @legado/reader-web build
pnpm --filter @legado/reader-web test
pnpm --filter @legado/reader-web test:db
pnpm run build:web:vercel
```

`test:db` 串行运行共享数据库的迁移和集成用例，默认检查迁移文件。真实 PostgreSQL 集成测试需要显式设置 `READER_WEB_TEST_DATABASE_URL`，只使用独立测试数据库；它执行全部迁移并创建临时受限角色，以验证缓存 upsert、RLS、认证 API、书单分组与移动故障回滚，结束后删除角色。未设置时跳过该集成测试，不读取项目 DATABASE_URL。

`build:web:vercel` 生成根目录 `public/index.html` 与 `public/static/`，这些是构建产物，不手动提交。`vercel.json` 把 `/api/*` 交给 Hono，其余深链回退到 `index.html`。

生产构建将小于 10 kB 的初始脚本内联到 HTML 的 body 末尾，省去启动脚本的独立请求；应用、页面及 CSS 继续异步加载。HTML 内置启动 loading，不依赖应用资源。Vercel 为 `/static/js/` 和 `/static/css/` 下带内容 hash 的构建资源设置一年 `immutable` 缓存；这些目录只能放置带内容 hash 的构建产物。

## PWA 安装

应用通过 `/static/pwa/manifest.webmanifest` 提供可安装的 PWA 配置，启动地址为 `/`，安装后使用独立窗口。应用名称与主屏幕短名称为“页灯”，描述为“为阅读，留一盏灯。”；书页与阅读灯融合的墨绿、暖金图标用于 manifest、favicon 与 iOS 主屏幕图标。原始设计文件位于 `../assets/brand/`，使用说明见 [视觉规范](../DESIGN.md)。浏览器需要 HTTPS，或在本地使用 `localhost`/`127.0.0.1`，才会显示安装入口；iOS 使用分享菜单添加到主屏幕。

PWA 资源使用 `no-cache`，让 manifest 和图标更新可以重新校验；带 hash 的前端脚本和样式仍使用长期缓存。当前 PWA 仍依赖在线认证和 API，不提供离线章节阅读或后台同步。

## Vercel

Vercel Project Root 必须是仓库根目录。Preview 和 Production 都要配置公开 Supabase 变量、服务端 Supabase 变量、数据库连接和运行状态密钥。第一次部署前在目标 Supabase 数据库执行迁移；构建过程只生成前端和函数产物。

搜索流使用 SSE 和请求取消，当前搜索仍在函数请求生命周期内执行，并受应用和平台时限约束。需要超过函数时限的订阅刷新、持久检测或后台任务不能通过继续复用当前搜索接口解决，应按根目录 archive 中的 JobStore 目标单独设计。

## 安全边界

浏览器只拿 publishable key 和脱敏 DTO。数据库密码、服务端密钥、Cookie、脚本变量和运行状态密钥只能在 Hono/Repository/Node runtime 使用。书源导入仅接受 HTTP(S) 地址，并限制响应、候选、重定向和处理时长。日志、SSE 和错误消息不能回显 Authorization、Cookie、密码或完整私有请求体。

书源导入弹窗支持链接下载和本地 JSON 文件。本地文件必须填写非空的 HTTP(S) 来源链接，用于导入历史和书源归属管理；服务端仅解析上传内容，不请求来源链接或文件中的 `sourceUrls`。文件使用 UTF-8 编码，本地文件和单次远程下载均最大 20 MiB，整个远程导入的累计下载量也限制为 20 MiB。JSON 字符串序列化需要转义引号和反斜线，因此整个导入请求允许最多 40 MiB 加 64 KiB 的来源链接及字段开销，超过限制返回 413。预览同时保存原始与规范化规则，独立限制为 61 MiB。两种方式均需预览并确认后保存。

Vercel Function 的请求体上限为 4.5 MB；上述服务端应用限制不会提高平台限制。本地 JSON 上传前，浏览器过滤整数类型中除文本 `0`、文本文件 `3` 之外的书源，保留未填写类型的旧书源；格式异常的类型交给服务端诊断。浏览器重新序列化 JSON 去掉缩进空白，并将包含来源链接和转义后 JSON 的完整请求限制为 4 MiB，超过时提示拆分文件，全部被过滤时不发起上传。远程下载由函数内部执行，不受该入站请求体限制，也不使用本地上传的类型过滤。

Node 宿主安全边界与共享兼容性见 [source-node 安全与部署](../../../packages/source-node/docs/security-and-deployment.md)；本文件只记录 reader-web 当前的本地和 Vercel 接入。
