# 后续待办事项

更新日期：2026-10-10。

这里只记录当前仍未完成、需要证据或需要单独决策的事项。已完成的 CLI 功能、文档整理过程和一次性审计记录不放在待办中；对应稳定事实见应用 docs、质量文档和运行时状态总览。

## 共享运行时与兼容性

- 为已有 source-core/source-node 能力补齐 Android 同输入 golden，区分 `ts-executed`、`android-evidence` 和 `verified`。
- 继续核对动态登录、WebView/`@webjs`、段评写入、付费动作、自定义事件和媒体宿主能力；缺少执行证据时保持 `capability-missing` 或 `not-run`。
- 维护真实书源 fixture、静态审计和显式在线审计，公网测试不能进入默认测试命令。
- 对 `source-core` 的目标 `RuntimeHost`/`OperationResult` 与当前 `WorkflowPorts`/`RuntimeResult` 差异继续登记，不在应用层自行伪造统一接口。

## reader-web

- 订阅自动刷新、订阅基线和冲突确认尚未接入当前 Web API。
- 持久 `JobStore`、Node Worker、租约恢复和跨请求长任务尚未实现；当前搜索取消只覆盖请求内 runtime。
- Android 旧 HTTP/WebSocket API 兼容适配器尚未实现；现有 Hono API 是 reader-web 自有接口。
- 完整 JSON/JavaScript 书源编辑器、规则静态诊断 UI 和真实请求预览尚未实现；当前导入页只负责预览和确认写入。
- 交互式登录、验证码、WebView 和站点专用浏览器能力仍需宿主协议、资源预算和安全边界设计。

## reader-cli

- 继续补 Android 页面行为对照和真机/跨端验证；应用功能和键位事实以 [`apps/reader-cli/docs/`](../apps/reader-cli/docs/README.md) 为准。
- 书源检测、调试和本地缓存已有实现，但代表性真实书源在线结果仍需按质量文档显式运行，不以离线测试替代。

## 决策边界

新增数据库、后台队列、兼容 API、编辑器或浏览器宿主前，先更新对应架构/能力文档并确认数据、权限、恢复成本和兼容影响。未完成项不得因为文档新增、类型检查通过或单源测试通过而改成“已实现”。

相关入口：

- [书源运行时状态总览](implementation/source-runtime-status.md)
- [能力清单](standard/capability-inventory.md)
- [已知差异](divergence/known-divergences.md)
- [reader-cli 实现方案](../apps/reader-cli/docs/implementation.md)
- [reader-web 实现方案](../apps/reader-web/docs/implementation.md)
