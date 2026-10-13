# `@legado/reader-web`

`@legado/reader-web` 是使用共享书源运行时的 Web 阅读器。浏览器端负责页面、账号和阅读交互，Hono API 在服务端调用 `@legado/source-core` 与 `@legado/source-node`；书源 Cookie、脚本变量和主要业务数据保存在服务端，浏览器只保存认证会话和阅读设置等前端状态。

当前应用提供书源导入预览与确认、启用/禁用和删除、跨来源搜索、书籍来源版本、目录、正文、书架、阅读位置和阅读设置。订阅自动刷新、持久后台任务、旧版 Android API 兼容、完整书源编辑器、WebView、验证码和交互式登录仍未实现，状态见[兼容性与验证](../../docs/compatibility/README.md)。

## 本地运行

需要一个 Supabase 项目和 PostgreSQL 数据库。复制 `apps/reader-web/.env.example` 为 `.env.local`，填写公开 Supabase 配置、服务端数据库连接和运行状态密钥；变量用途、认证回调和安全边界见[开发与部署](docs/development-and-deployment.md)。

先执行数据库迁移：

```bash
pnpm --filter @legado/reader-web db:migrate
```

再分别启动 API 和前端：

```bash
pnpm --filter @legado/reader-web dev:api
pnpm --filter @legado/reader-web dev
```

应用不会自动读取仓库中的 `fixtures/source/`；书源由当前账号在“书源管理”页面导入。数据库迁移是显式操作，启动和构建不会替代迁移。

## 文档

- [Web 文档入口](docs/README.md)
- [架构](docs/architecture.md)
- [当前实现](docs/implementation.md)
- [交互说明](docs/interaction.md)
- [存储与缓存](docs/storage-and-cache.md)
- [开发与部署](docs/development-and-deployment.md)
- [视觉规范](DESIGN.md)

## 检查与构建

```bash
pnpm --filter @legado/reader-web typecheck
pnpm --filter @legado/reader-web build
pnpm --filter @legado/reader-web test
pnpm --filter @legado/reader-web test:db
```

真实 PostgreSQL 集成测试需要显式提供独立的 `READER_WEB_TEST_DATABASE_URL`；未设置时不会读取项目的 `DATABASE_URL`。Vercel 的根目录、迁移顺序、静态产物和深链配置见[开发与部署](docs/development-and-deployment.md)。
