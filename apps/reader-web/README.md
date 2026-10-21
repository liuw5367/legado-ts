# `@legado/reader-web`

`@legado/reader-web` 是使用共享书源运行时的 Web 阅读器。浏览器端负责页面、账号和阅读交互，Hono API 在服务端调用 `@legado/source-core` 与 `@legado/source-node`；书源 Cookie、脚本变量和主要业务数据保存在服务端，浏览器只保存认证会话和阅读设置等前端状态。

当前应用提供书源导入预览与确认、启用/禁用和删除、跨来源搜索、书籍来源版本、目录、正文、书架、阅读位置和阅读设置。设置页支持与 CLI 共用格式的第一版用户数据 ZIP 导入导出，导入会先完整校验，再默认全选并按分类完整覆盖。订阅自动刷新、持久后台任务、旧版 Android API 兼容、完整书源编辑器、WebView、验证码和交互式登录仍未实现，状态见[兼容性与验证](../../docs/compatibility/README.md)。

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

应用不会自动读取仓库中的 `fixtures/source/`；书源由当前账号在“书源管理”页面导入。数据库迁移是显式操作，启动和构建不会替代迁移。远程书源加载的单次响应上限为 10 MiB；仅保留文字书源（`bookSourceType: 0`，缺省按文字处理），漫画、音频等其他类型会直接过滤，不进入预览或保存。

无需连接真实 Supabase 或数据库即可进行页面手工验收：启动 `pnpm --filter @legado/reader-web dev:page-fixture`，再按[页面验收模拟服务](docs/page-test-fixture.md)启动前端并使用文档里的测试账号登录。模拟数据只保存在测试服务进程内。

备份导入导出保留书架、阅读位置、搜索记录、书源定义与状态、当前 Web 阅读设置和恢复所需的书籍版本/候选数据。选中分类会完整替换对应账号数据，未选分类保持不变；校验或事务失败不会留下半套数据。当前固定为第一版格式，不提供历史 CLI 数据迁移。

跨端 ZIP 使用 CLI 的固定路径和共同字段。Web 当前数据模型没有 `openedBookIds`、CLI 数值搜索摘要、阅读记录级 `lastOpenedAt`/独立更新时间、候选确认时间和 CLI 书源检测 health/check，因此导出时分别写空数组、保存可表达的状态/结果数/文本摘要、按现有 position 重建或使用空检测配置；这些字段不通过数据库迁移伪造恢复。

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
