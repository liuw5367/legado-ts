# 实施总路线与阶段交付

本章说明未来如何把行为规格实现为独立 TypeScript package。当前 `typescript/packages/` 尚无实现，以下路径都是建议目标，不是现有文件。目标是先做一个可独立测试的书源核心，再增加 Node 宿主和应用入口。每个阶段均应有可单独验收的公开能力；低优先级能力保留在 [能力清单](19-capability-inventory.md) 中，不会因为阶段划分而消失。

## 建议目录与依赖方向

```text
packages/source-core/
  src/codec/           原文、schema、导入导出和诊断
  src/rules/           规则切分、模式识别、求值和变量
  src/request/         URL 展开、请求描述和响应归一化
  src/flows/           发现、搜索、详情、目录和正文
  src/javascript/      JS 源配置、调用与返回值归一化
  src/public/          稳定的 package 入口和错误类型
packages/source-node/  Node 宿主端口实现
apps/source-harness/   开发与验收入口，不承担规则语义
fixtures/             脱敏输入和预期结果
```

依赖方向为 `public -> flows -> rules/request/codec -> host ports`。宿主实现只实现端口，不反向调用应用内部状态。`apps/source-harness` 从公开入口调用 package，用来证明它无需 Android UI 或数据库也能工作。Next.js、React Router 或 SPA 服务端复用同一 package API；实现前不要为每个框架复制规则层。

## 实施阶段

| 阶段 | 可交付能力 | 详细文档 | 本阶段验收 |
| --- | --- | --- | --- |
| A | JSON 导入、规范化、导出、静态诊断、订阅差异计算和 JS 原文保留 | [模型与导入](22-implement-codec-editor.md) | JSON 往返、订阅冲突可独立使用；JS 动态配置在 B |
| B | 规则、请求、变量、基础 JS 桥接与 Node 参考宿主 | [规则与请求](23-implement-rules-request.md) | 固定规则求值、JS 配置抽取、同步网络外观、取消和清理；可独立预览 |
| C | 声明式与基础 JS 的发现、搜索、详情、目录、正文；最小部署验收 | [主流程](24-implement-workflows.md) | 公开入口一书一章、本地 HTTP 及目标 Node 部署验收 |
| D | 批量、媒体、段评、事件、复杂认证和浏览器等扩展 | [扩展能力](25-implement-extended-capabilities.md) | 每项单独验收，不影响 C 已有能力 |
| E | SPA 服务端接口、框架接入、部署验证与维护 | [接入和发布](26-implement-integration-verification.md) | 应用只调用 package，Node 端到端流程与目标宿主验证通过 |

阶段 A 和 B 已能独立服务书源编辑、诊断与规则预览；阶段 C 可用于普通书源的完整阅读流程。阶段 D 按能力逐项增加，已实现能力持续可用。阶段 E 只增加服务端入口和维护机制，不改变规则结果。每个阶段完成后都更新 [兼容性矩阵](13-compatibility-matrix.md)，记录已实现与未实现能力，而不是以整个 package 的单一“完成”状态代替。

基础 JS 与真实 Node 网络不能全部留到 D：声明式规则的 URL、插值和 loginCheckJs 已依赖它们。B 的无 JS 子集可先发布预览能力，但 B 的完整验收必须通过同步桥接专项测试。C 的部署入口是验收 harness；E 才增加面向应用的完整适配和维护，不把首次部署检查推迟到 E。

阶段负责人遇到 [能力阻塞](19-capability-inventory.md#尚不能进入完整实现验收的项目) 时，只暂停依赖该能力的验收。是否新增服务或舍弃能力由用户决策；不能以阶段编号完成替代细项验证。版本、发布及来源记录以 [维护文档](30-package-maintenance.md) 为准。

## 开工前的基线

1. 从 Android 源码和测试确定本阶段涉及的字段、规则、入口、异常及顺序，按 [测试基线](15-conformance-tests.md) 建立脱敏 fixture。已有 Kotlin 测试可作为证据，但缺少输入和预期结果的条目仍标记待验证。
2. 固定 package 的公开输入、输出、错误与宿主端口。每次调用必须携带书源快照、请求身份和取消信号；持久化提交由应用或宿主完成。
3. 明确能力状态：某项能力是已实现、待实现、需要宿主、还是只有字段证据。`BookSource` 未知字段和低优先级字段始终可导入、显示、导出。
4. 每个阶段先通过本阶段 fixture，再用组合测试从公开入口执行，最后更新对应文档状态。不能仅凭类型检查或内部函数单测宣称流程兼容。

## 阶段完成与变更原则

每个阶段的产物应能在没有下一阶段代码的情况下使用、测试和回退。公开 API、规则语义和原始书源格式分别记录版本；改变既有书源输出时先增加 Android/TypeScript 对照样本，再决定兼容修复或显式版本分流。阶段 D 中任何建议放弃的能力需单独列出理由与损失，等待用户审核，不能由实现困难自动变为非范围。
