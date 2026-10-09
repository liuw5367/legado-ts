# Legado Reader Web

这是阅读器 Web SPA 的应用目录。前端使用 Rsbuild + React Router，基础控件按 `components.json` 的 shadcn 约定放在 `src/components/ui/`，API 使用 Hono Node Functions；认证由 Supabase Auth 处理。

## 本地运行

复制 `.env.example` 为 `apps/reader-web/.env.local`，填入 Supabase 的公开 URL、publishable key 和服务端 `DATABASE_URL`。API、Drizzle 迁移和 Drizzle 配置会自动读取这个文件；如果环境文件放在其他位置，可设置 `READER_WEB_ENV_FILE` 指向它。先执行数据库迁移：

```sh
pnpm --filter @legado/reader-web db:migrate
```

新增迁移后重新执行一次 `db:migrate`，不要在每次 Web 部署时自动运行迁移。

`fixtures/source/` 是部署者维护的共享书源目录，Web 会按 CLI 的目录规则递归读取 `.json` 和 `.js` 文件，解析集合文件、跳过符号链接、限制文件数量/大小，并过滤无效与冲突书源；Vercel 函数通过 `vercel.json` 的 `includeFiles` 将该目录随服务端一起打包。需要临时使用其他目录时，可设置服务端变量 `READER_SOURCES_DIR`。用户的搜索、书架、目录缓存、阅读位置以及书源 Cookie/脚本变量按 Supabase 用户 ID 隔离。`SOURCE_RUNTIME_STATE_KEY` 至少使用 32 个字符的随机服务端密钥（例如 `openssl rand -base64 32` 的结果），用于 AES-256-GCM 加密书源运行状态；轮换该密钥会使旧 Cookie 和脚本变量失效。不要把数据库密码、Cookie 或运行状态密钥放入前端环境变量。

阅读设置页提供跟随系统、浅色和夜间三种页面模式，以及字号和行距。设置保存在当前账号，书籍的每个书源版本也分别保存目录和阅读位置。搜索结果可以选择新建书籍，或追加到已有书籍作为新的来源版本。

启动 API：

```sh
pnpm --filter @legado/reader-web dev:api
```

另开终端启动前端：

```sh
pnpm --filter @legado/reader-web dev
```

注册、邮箱验证和密码恢复需要 Supabase 项目配置邮件服务；本地 Supabase 可以使用 Mailpit。

在 Supabase Auth 的 Confirm signup 和 Reset password 模板中分别使用 `auth-email-templates/confirm-signup.html` 与 `auth-email-templates/reset-password.html`。模板把 `token_hash` 交给站内回调验证；生产环境必须配置自定义 SMTP，并把本站地址加入 Redirect URL 白名单。

## Vercel 部署

Vercel 项目必须把仓库根目录作为 Project Root。根目录的 `vercel.json` 使用 Hono 适配器承载 API，构建命令会先生成 Rsbuild 静态资源，再复制到根目录 `public/`；该目录是构建产物，不应手动提交。

在 Vercel 的 Preview 和 Production 环境分别配置以下变量：

| 变量 | 用途 |
| --- | --- |
| `PUBLIC_SUPABASE_URL` | 浏览器构建时使用的 Supabase URL |
| `PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 浏览器构建时使用的 Supabase publishable key |
| `SUPABASE_URL` | Hono 函数校验登录令牌 |
| `SUPABASE_PUBLISHABLE_KEY` | Hono 函数校验登录令牌 |
| `DATABASE_URL` | Supabase Postgres 连接串 |
| `SOURCE_RUNTIME_STATE_KEY` | 服务端加密每用户书源 Cookie/脚本变量的密钥，至少 32 个字符 |

第一次部署前，在目标 Supabase 数据库执行迁移；Vercel 构建不会自动修改数据库：

```sh
pnpm --filter @legado/reader-web db:migrate
```

Supabase Auth 的 Site URL 和 Redirect URL 需要包含部署域名。注册确认和密码恢复回调分别使用 `/auth/confirm` 与 `/reset-password`，邮件模板仍按上面的 `auth-email-templates/` 文件配置。

本地可以先验证与 Vercel 相同的静态产物准备步骤：

```sh
pnpm run build:web:vercel
```

该命令会生成 `public/index.html` 和 `public/static/`，并让 Vercel 函数携带 `fixtures/source/`；部署配置会把 `/api/*` 交给 Hono，把其他前端深链回退到 `index.html`。搜索流式响应启用 60 秒函数上限和请求取消支持；如书源响应可能超过此时长，需要后续把搜索任务拆为后台队列。

## 检查

```sh
pnpm --filter @legado/reader-web typecheck
pnpm --filter @legado/reader-web build
pnpm --filter @legado/reader-web test
```
