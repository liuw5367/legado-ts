# Legado Reader Web

这是阅读器 Web SPA 的应用目录。前端使用 Rsbuild + React Router，API 使用 Hono Node Functions；认证由 Supabase Auth 处理。

## 本地运行

复制 `.env.example` 为本地环境文件并填入 Supabase 的公开 URL、publishable key 和服务端 `DATABASE_URL`。先执行数据库迁移：

```sh
pnpm --filter @legado/reader-web db:migrate
```

`READER_SOURCES_JSON` 是部署者维护的书源数组，所有用户共享书源定义；用户的搜索、书架、目录缓存和阅读位置按 Supabase 用户 ID 隔离。不要把数据库密码、Cookie 或运行状态密钥放入前端环境变量。

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

## 检查

```sh
pnpm --filter @legado/reader-web typecheck
pnpm --filter @legado/reader-web build
pnpm --filter @legado/reader-web test
```
