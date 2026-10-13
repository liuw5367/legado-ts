# `@legado/source-core`

`source-core` 是平台无关的书源解析和工作流包。它负责导入/导出、规则编译与求值、请求计划、书源会话，以及搜索、发现、详情、目录、正文、批量正文和图片解密；它不直接访问网络、文件系统、数据库、浏览器或用户凭据。

## 维护入口

| 主题 | 文档 |
| --- | --- |
| 当前公开导出 | [API 索引](docs/api.md)；完整类型以 [`src/index.ts`](src/index.ts) 和 `.d.ts` 产物为准 |
| 结果、请求和错误 | [运行时契约](docs/runtime-contracts.md) |
| 宿主端口与存储责任 | [宿主端口](docs/host-ports.md) |
| 导入、身份和订阅 | [Codec 与订阅](docs/codec-and-subscriptions.md) |
| 规则、变量和请求 | [规则与请求](docs/rules-and-requests.md) |
| 搜索、阅读和缓存工作流 | [工作流](docs/workflows.md) |
| Android 差异和验证状态 | [兼容性与验证](../../docs/compatibility/README.md) |
| Node 集成 | 迁移期间见[跨包与应用接入](../../docs/implementation/package-usage.md)；Node 宿主文档在后续任务建立 |

## 边界

- `source-core` 的工作流接收 `WorkflowPorts`/`ReadingPorts`，由调用方提供 `NetworkHost`、规则宿主、解析器、编码、并发和正文 `ContentStore` 等能力。
- 工作流使用 `success`、`partial`、`empty`、`failed`、`cancelled` 和 `capability-missing`；`stale`、`unknown` 等存储提交状态由端口返回，不能伪装成 core 终态。
- `refreshSubscription` 只计算远程、本地和基线快照之间的差异及 `commitPlan`，不保存、调度或自动覆盖应用数据。
- 书源原文、未知字段和字段形态由 codec 保留；应用决定候选是否写入自己的 Repository。

## 本地开发

包声明位于 [`package.json`](package.json)，测试位于 [`tests/`](tests/)。修改公开类型或文档示例时，先核对 `src/index.ts` 的导出，再运行与主题对应的现有测试；不要以 package 能构建推断 Android 同输入兼容已经完成。
