# 书源运行时状态总览

本文是书源解析、宿主能力和 Android/TypeScript 一致性验证的唯一状态入口。详细行为仍分别记录在能力清单、差异登记和测试基线中；这些文档不再维护第二份状态表。

## 状态定义

| 状态 | 含义 |
| --- | --- |
| `未实现` | 当前没有可用的 TypeScript runtime、宿主适配器或应用入口 |
| `部分实现` | 已覆盖部分路径，但仍缺少生命周期、重载、宿主能力或关键行为 |
| `差异待处理` | 已确认与 Android 或目标契约不同，尚未修复或完成取舍 |
| `已实现待验证` | TypeScript 已实现并有测试，但缺少 Android 同输入 golden |
| `有意保留` | 差异来自安全或产品边界，暂不按 Android 行为消除 |
| `待整理` | 实现或文档已经变化，需要同步事实来源 |
| `已完成` | 完成条件、日期、提交和测试证据均已记录 |

## 未完成项和差异项

| 编号 | 类型 | 事项 | 当前状态 | 详细事实和证据 | 完成条件 |
| --- | --- | --- | --- | --- | --- |
| OPEN-01 | 宿主能力 | `@webjs`、WebView、资源嗅探和浏览器交互 | 未实现 | [兼容矩阵](../quality/compatibility-matrix.md)；[宿主接口](runtime-host-interfaces.md) | 宿主端口、权限边界、能力错误和 Android fixture 齐备 |
| OPEN-02 | 书源能力 | 结构化段评读取、旧式段评网页桥接和段评写入 | 部分实现 | [段评流程](../flows/review-flow.md)；`CAP-REVIEW` | 读取、会话安全、分页和写入协议分别完成或明确返回能力缺失 |
| OPEN-03 | 书源能力 | 付费动作、购买后刷新、书源事件和自定义按钮 | 未实现 | [媒体和交互流程](../flows/adjacent-source-flows.md) | 触发、认证、取消、重复点击和宿主 UI 动作有版本化契约 |
| OPEN-04 | 宿主能力 | 验证码、复杂登录 UI 和多步骤登录 | 未实现 | [URL 与请求规则](../standard/url-request-rules.md)；WebView 入口 | 登录交互、凭据保存、清理和失败恢复完成应用与宿主验收 |
| OPEN-05 | 应用入口 | 多源 `searchMany`、书源全流程 `checkSources` | 未实现 | [包使用指南](package-usage.md)；[校验流程](../flows/source-check-flow.md) | 多源调度、进度、取消、部分成功和全流程校验有公开入口与测试 |
| OPEN-06 | 应用状态 | `SourceApplicationService`、`SourceRepository`、`SecretStore`、`JobStore` | 未实现 | [架构边界](../architecture/goals-and-boundaries.md)；[归档设计](../archive/source-management-and-state.md) | 用户归属、版本冲突、凭据隔离、任务恢复和删除副作用有应用层契约 |
| OPEN-07 | 请求差异 | Android 独立登录凭据头与同站注入 | 部分实现 | [差异登记](../divergence/known-divergences.md)，D5 | Android/TypeScript 使用相同请求和 Cookie fixture，且清理边界明确 |
| OPEN-08 | 生命周期差异 | `concurrentRate` 非法配置和源生命周期清理 | 部分实现 | [差异登记](../divergence/known-divergences.md)，D7 | 首次非法值、取消、编辑、覆盖、删除和重建源都有测试 |
| OPEN-09 | JavaScript bridge | 平台方法和逐重载兼容 | 部分实现 | [差异登记](../divergence/known-divergences.md)，D14；[宿主方法盘点](../standard/capability-inventory.md#宿主方法补充盘点) | 真实书源用到的方法逐重载通过，未支持方法返回明确能力状态 |
| OPEN-10 | 跨端验证 | 已实现解析和工作流的 Android 同输入 golden | 已实现待验证 | [一致性测试基线](../quality/conformance-tests.md) | 同一脱敏 fixture 在 Android 和 TypeScript 两侧通过稳定输出比较 |
| D1 | 接口差异 | 搜索与流程入口命名 | 有意保留 | [差异登记](../divergence/known-divergences.md)，D1 | 入口统一，或文档完成迁移并通过包入口测试 |
| D2 | 接口差异 | 端口与宿主门面命名 | 有意保留 | [差异登记](../divergence/known-divergences.md)，D2 | 宿主门面和结果契约统一，或所有现行入口完成文档迁移 |
| D3 | 文档差异 | 能力清单中过时的“未实现”表述 | 待整理 | [差异登记](../divergence/known-divergences.md)，D3 | 能力清单、矩阵和实现状态不再使用过时表述 |
| D4 | 能力差异 | 尚未实现的公开能力 | 差异待处理 | [差异登记](../divergence/known-divergences.md)，D4 | 每项缺失能力都有独立状态、宿主边界和可识别错误 |
| D5 | 请求差异 | Android 独立登录凭据头 | 部分实现 | [差异登记](../divergence/known-divergences.md)，D5 | 登录凭据、Cookie、同站注入和清理完成跨端验证 |
| D6 | 请求差异 | 默认 User-Agent | 部分实现 | [差异登记](../divergence/known-divergences.md)，D6 | Android 默认值、宿主注入和覆盖优先级有 fixture |
| D7 | 生命周期差异 | `concurrentRate` 生命周期 | 部分实现 | [差异登记](../divergence/known-divergences.md)，D7 | 非法配置、取消和源生命周期清理完成测试 |
| D8 | 安全差异 | HTTP、协议和本地地址限制 | 有意保留 | [差异登记](../divergence/known-divergences.md)，D8 | 安全审查完成并明确兼容边界 |
| D9 | 请求差异 | bridge 子请求的动态 Header 重入 | 差异待处理 | [差异登记](../divergence/known-divergences.md)，D9 | 重入次数、请求顺序和有界策略有 Android 对照 |
| D10 | 生命周期差异 | `preUpdateJs` 执行时限 | 差异待处理 | [差异登记](../divergence/known-divergences.md)，D10 | 取消、超时和有界预算完成 Android 对照与取舍记录 |
| D11 | 生命周期差异 | `subContent` 取消语义 | 差异待处理 | [差异登记](../divergence/known-divergences.md)，D11 | 主正文、诊断和最终状态完成 Android 对照与取舍记录 |
| D12 | 二进制差异 | 封面解密 InputStream 互操作 | 部分实现 | [差异登记](../divergence/known-divergences.md)，D12 | 所需重载和 bytes 边界都有跨端 fixture |
| D13 | 二进制差异 | 图片脚本执行预算 | 部分实现 | [差异登记](../divergence/known-divergences.md)，D13 | 预算、取消、资源释放和大输入行为都有跨端 fixture |
| D14 | JavaScript bridge | JavaScript bridge 逐重载覆盖 | 部分实现 | [差异登记](../divergence/known-divergences.md)，D14 | 真实书源方法逐重载通过，未支持方法明确返回能力状态 |

## 完成时如何更新

完成一项时，只在本文更新状态总览：

1. 将“当前状态”改为 `已完成（YYYY-MM-DD，提交，测试命令）`，或改为 `已完成（有意保留，YYYY-MM-DD，决策和测试）`。
2. 给同一行的“编号”和“事项”加删除线，保留该行以及详细证据链接。
3. 在对应详细文档中补充行为、实现和测试证据，不再创建第二份状态表。
4. 如果后续回归，恢复删除线和未完成状态，并在详细文档追加回归原因和新的验证结果。

例如：

```text
| ~~D7~~ | 生命周期差异 | ~~concurrentRate 生命周期~~ | 已完成（2026-10-01，abc123，pnpm run test:source） | ... | ... |
```

机器清单中的 fixture ID 保持稳定，不删除历史记录；它们的 `execution` 字段由[一致性测试基线](../quality/conformance-tests.md)维护。
