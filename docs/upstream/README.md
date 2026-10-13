# 上游资料索引

本目录保存 Android 页面事实和外部教程的来源入口。这里回答“原始材料是什么、适用哪个版本、可以证明什么”；当前 TypeScript 是否实现、测试是否执行，统一看[兼容性与验证](../compatibility/README.md)，不要把上游资料目录当成实现状态表。

## 来源分层

| 材料 | 本地入口 | 用途 | 可信边界 |
| --- | --- | --- | --- |
| Android 页面行为快照 | [Android 页面](android/README.md) | 对照页面入口、状态、请求顺序、持久化和交互 | 来自 2026-09-28 上级工程快照；静态源码和测试证据不能替代真机运行 |
| Android 规则与源码基线 | [维护与迁移证据](../operations/package-maintenance.md) | 对照书源字段、规则、宿主方法和长期变更 | 固定 SHA 用于取证；上游更新后必须重新核对，不自动继承旧结论 |
| 外部社区教程 | [Legado 书源规则说明](tutorials/legado-source-rules.md) | 查阅教程中的规则示例和术语 | 本地是抽取整理，不定义本仓契约，不代表授权或当前实现 |

## Android 基线

Android 页面和规则使用两份不同用途的固定提交。页面快照来自上级工程提交 `32a87b253e7cc28273c3850de86242caac83f1fd`，扫描日期为 2026-09-28；它用于核对页面入口、交互状态、请求顺序、保存和清理。长期规则和源码引用基线是 `62003ce732a7e30602754d28996da7f98b9ea296`；它用于核对 `BookSource`、`AnalyzeRule`、`AnalyzeUrl`、`WebBook`、JavaScript 扩展、宿主端口和测试。两者用途不能互换。

固定来源：

- [页面快照提交](https://github.com/LegadoTeam/legado/commit/32a87b253e7cc28273c3850de86242caac83f1fd)
- [长期规则基线提交](https://github.com/LegadoTeam/legado/commit/62003ce732a7e30602754d28996da7f98b9ea296)
- 页面事实的本地拆分：[Android 页面目录](android/README.md)
- 规则事实的维护流程：[package 维护与迁移证据](../operations/package-maintenance.md)

引用 Android 源码时必须同时记录仓库、固定提交、相对路径、符号或测试名，以及它要证明的行为。行号只能辅助定位；没有真机或跨端执行证据时，状态仍保持 `not-run` 或“待验证”。`modules/web/` 是管理界面，不能替代运行时规则引擎。

## 页面与教程

Android 页面按页面拆分，入口从[页面索引](android/README.md)进入；页面文档保留页面事实，不复制 TypeScript 工作流。教程保留原作者、原文地址、原文更新时间和使用声明；本地整理日期不冒充原文更新时间，也不扩大镜像范围。

教程元数据：

| 字段 | 内容 |
| --- | --- |
| 标题 | 《从入门到入土》书源规则抽取版 |
| 原作者 | Celeter |
| 现有整理署名 | 喵公子 |
| 原文更新时间 | 2024-02-27 |
| 原文地址 | [The-tutorial-of-Legado · Rule/source](https://mgz0227.github.io/The-tutorial-of-Legado/Rule/source.html) |
| 本地用途 | 查阅镜像；与 Android 规则或本仓标准冲突时，以固定 Android 证据和本仓兼容政策为准 |

本目录不重新抓取上游或教程，不把网络可达性写成来源有效性结论。上游变更、许可证和重新取证步骤见[维护与迁移证据](../operations/package-maintenance.md)。
