# reader-web 页面验收模拟服务

`tests/fixtures/page-test-server.mjs` 提供独立的本地认证响应和内存 API，用于手工检查页面布局、导航、搜索、目录、正文、书源切换和设置。它不连接 Supabase、PostgreSQL 或真实书源，服务重启后数据会恢复初始状态。

## 启动

在仓库根目录开两个终端。第一个启动模拟 API 和认证服务：

```bash
pnpm --filter @legado/reader-web dev:page-fixture
```

页面验收时用这个服务代替 `dev:api`；它占用相同的 8787 端口。

第二个终端把浏览器端 Supabase 配置指向模拟服务并启动前端：

```bash
PUBLIC_SUPABASE_URL=http://localhost:8787 \
PUBLIC_SUPABASE_PUBLISHABLE_KEY=reader-web-page-fixture-key \
pnpm --filter @legado/reader-web dev
```

打开 `http://localhost:3000/login`，使用以下测试账号：

```text
reader@example.test
fixture-password
```

测试账号只由本地模拟认证端点接受。不要将这组凭证配置到真实 Supabase 项目。

## 样例数据

- 书架和阅读记录包含一本《星海旅人》，有两个书源版本和30章目录，默认停留在第二章。
- 书源管理包含65个启用书源；书源地址使用保留的 `.test` 域名，不对应真实网站。
- 搜索最多逐个返回5个同书名结果，并间隔80毫秒发送 SSE 事件，便于检查结果逐步出现、取消与来源选择。
- 正文包含28段；刷新正文会显示递增的刷新标记。
- 书名、书籍地址和章节地址包含较长文本，可检查窄屏下的省略和操作按钮位置。

模拟 API 支持页面验收所需的登录、首页、书源列表、搜索流、书籍详情、版本、目录、正文、阅读位置和设置接口。搜索、书架、阅读位置、设置和书源管理操作会修改当前进程内的数据；停止服务后这些修改会清空。请求日志只输出方法、路由和 `refresh=true` 或 `all=true` 标记，不记录请求体、认证头或搜索词。

该服务用于页面与交互验收，不替代 Hono API、Supabase、PostgreSQL、书源解析或真实 iPhone Safari 的集成验证。
