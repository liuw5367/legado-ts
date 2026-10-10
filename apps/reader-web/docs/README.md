# reader-web 文档

这里记录 Web 阅读器的当前实现。共享书源规则、工作流和兼容性要求在仓库根目录的 [`docs/`](../../../docs/README.md) 维护；视觉令牌和组件风格仍在 [`DESIGN.md`](../DESIGN.md)。

| 文档 | 回答的问题 |
| --- | --- |
| [架构](architecture.md) | 浏览器、Hono、运行时、Repository 和数据库怎样协作 |
| [实现方案](implementation.md) | 导入、搜索、书籍、目录、正文和取消怎样执行 |
| [交互说明](interaction.md) | 路由、页面状态和用户操作是什么 |
| [存储与缓存](storage-and-cache.md) | 用户数据、版本、缓存和运行状态如何隔离 |
| [开发与部署](development-and-deployment.md) | 本地配置、迁移、构建和 Vercel 部署如何操作 |

README 负责最短启动说明；本目录负责开发者需要的稳定边界。当前代码与测试是事实来源，未实现的订阅、后台任务、兼容旧 API 和完整编辑器仍见根目录 archive 中的历史目标文档。
