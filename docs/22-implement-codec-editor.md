# 阶段 A：模型、导入与编辑基础

先建立不依赖网络、DOM 或应用数据库的书源数据层。它负责识别输入、保留原文、规范化字段、产生诊断和可写入候选。宿主可以提供远程读取与 URI 读取，但是否保存候选始终由调用方决定。行为依据是 [书源模型](02-source-schema.md)、[导入协议](03-import-protocol.md) 和 [编辑器规划](16-source-editor.md)。

## 实现顺序

1. 定义公开的 `RawSource`、`NormalizedSource`、`ImportCandidate`、`ImportDiagnostic` 与 `SourceVersion`。`RawSource` 保留原文、输入位置、规则字段原始形态和未知字段；`NormalizedSource` 只用于运行与表单，不覆盖原文。
2. 实现 JSON 对象、数组、远程 URL、URI 与 JS 文本的分类。远程和 URI 只通过读取端口取得文本，再回到同一解析入口；`sourceUrls` 只允许文档定义的外层展开，并限制数量、响应大小、深度和取消。
3. 先按原文解析，再按书源名和 URL 依次应用导入替换规则；严格解析失败时按兼容路径尝试宽松 JSON，并记录诊断。替换失败留下原候选与错误，不把部分替换写入存储。
4. 对 `BookSource`、`ruleExplore`、`ruleSearch`、`ruleBookInfo`、`ruleToc`、`ruleContent`、`ruleReview` 做字段级校验。规则字段的对象与 JSON 字符串形态均被接受，未知字段和历史值保留。为每个字段记录默认值、空值含义、执行能力和导入导出策略。
5. 以原始 bookSourceUrl 生成候选身份，不进行网络地址规范化；与本地快照比较 new/update/same/conflict，由应用确认后事务保存。
6. 导出验证未知字段和规则形态；JS 原文保持完整，动态配置抽取在 [阶段 B](23-implement-rules-request.md) 完成。
7. 实现 [订阅差异](28-source-subscriptions.md) 的纯比较入口：base/remote/local 三方比较、用户字段保护与 sourceVersion 冲突；下载使用读取端口，定时器和持久化仍属于应用。

## 编辑器如何复用这一层

编辑会话持有 `rawText`、`baseText`、`baseVersion`、规范化对象、诊断和 dirty 状态。每次字段修改都产生新的候选文本，并再次经过同一 codec；表单不能把字段顺序、未知字段或 `mainJs` 清空。保存时再次校验并比较版本，冲突由应用让用户选择重新载入、覆盖或导出副本。阶段 A 的预览只显示分类、schema 与规则静态诊断；网络与真实规则结果须等阶段 B、C 的同一核心入口可用后再接入。

```text
输入文本或读取结果
  -> 分类和原文快照
  -> 替换、解析、规范化、诊断
  -> 候选与本地版本比较
  -> 编辑或用户确认
  -> 导出文本或应用事务保存
```

应用保存完成后才发布书源更新事件，携带书源身份和新版本。后续缓存与运行上下文用该版本避免旧规则结果覆盖新结果。编辑器保存失败仍保留原始文本和 dirty 状态，不能只留下规范化对象。

## 对外接口与验收

本阶段需要稳定的 `importSources`、`diagnoseSource`、`exportSource` 和候选比较入口。输入接受 `AbortSignal` 与读取端口；输出只包含候选、诊断及可安全展示的差异摘要，不自动暴露原始 Cookie 或私有 Header。JS 动态配置尚不能执行时，候选必须明确 `requires-javascript`，不能伪装成完整可运行的书源。

以 IMP、EDIT 的具体子案例及 SUB-001–008 验收；JS 动态配置断言在 B 执行，A 不伪称 JS 已可导入运行。每个字段分别做往返断言，从公开入口导入、修改、导出、重导入。应用存储测试覆盖确认、并发冲突与事务失败，不把数据库实现纳入核心。
