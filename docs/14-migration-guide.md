# 迁移实施顺序概览

实际编码的唯一阶段定义见 [实施总路线](21-implementation-roadmap.md)。本页按阅读任务提供依赖概览，不另设一套阶段：A 数据层，B 规则/请求/基础 JS 与 Node 宿主，C 主流程与最小部署验证，D 扩展，E 应用与维护。

## 当前交付状态

当前交付物是行为规格和迁移设计文档，不包含 TypeScript runtime、Node adapter、独立编辑器或 Android 对照 golden。文档中的接口、兼容性矩阵和测试样例是后续实现的约束，不能据此宣称 TypeScript 已经兼容。

现阶段已经有 Android/Kotlin 源码和部分 Android/Web 测试作为事实依据，但仍需要把关键行为整理成脱敏 fixture，并为每个 fixture 建立 TypeScript 自动断言。只有两者都存在，才可以把兼容矩阵中的 TS 状态改为已验证。

## 阅读任务：行为证据

先完成规则、URL、发现、搜索、详情、目录和正文流程的 Android fixture，记录输入 body、规则文本、上下文变量、输出 JSON、异常类型和日志阶段。fixture 必须脱敏，不保存真实 Cookie、Token 或账号。

行为基线还必须记录每条流程的状态转换、请求启动与完成顺序、缓存命中与写入、持久化变更、事件/回调顺序、取消出口和资源清理结果。只有结果 JSON 没有这些处理记录时，不能证明流程兼容。

## 阅读任务：规则核心（对应 B）

按以下依赖顺序实现：

1. 兼容分隔器：按原规则/代码平衡边界处理括号、引号和转义，不全局修正历史切分；
2. SourceRule 模式识别；
3. Default DOM 选择、链、文本/属性输出；
4. 索引、范围、排除和 `&&/||/%%`；
5. XPath、JSONPath、Regex；
6. `$n`、`@put/@get`、`{{}}` 和替换；
7. `getString`、`getStringList`、`getElement`、`getElements` 归一化。

每一步都必须先通过对应 conformance fixture，再进入下一层。

## 阅读任务：URL 与宿主（对应 B）

实现 URL 规则展开与请求描述，不在核心中绑定 fetch、axios、undici 或某个 DOM 库。同步补齐 `VariableStore`、`JavaApi`、`SourceApi` 和 capability 接口，明确每个端口的输入、输出、错误和所有权。Node adapter 先实现普通 HTTP；WebView、代理、DNS 覆盖和复杂认证以能力接口增加。

## 阅读任务：领域流程（对应 C）

先实现发现分类，再依次实现发现列表、搜索、详情、目录、正文。流程代码只调用规则核心和 host port，不重新实现字段规则。每个流程要固化输入 DTO、状态机、请求和解析顺序、空值、分页、取消、超时、缓存、持久化、回调和重复数据；每个阶段都要有成功、部分失败和清理后的输出。

## 阅读任务：基础 JS（对应 B/C）

实现配置抽取、脚本沙箱、返回值 JSON 归一化、marshaller 和 [JavaScript 书源宿主 API](11-runtime-host-interfaces.md#javascript-书源宿主-api)。先支持普通函数和静态变量，再增加批量；复杂登录和 WebView 排在后续宿主能力，但登录函数配对、静态登录头和 capability error 必须先有 fixture。完整能力的实施状态按 [能力清单](19-capability-inventory.md) 逐项推进，不因当前阶段尚未实现就删掉目标。

## 阅读任务：应用和编辑器（对应 A–E）

Node API 作为 SPA/SSR 的服务端边界；编辑器复用 codec、诊断和 preview。核心边界从 A 建立，Node 与基础 JS 在 B 接入，C 验证领域组合及最小部署；独立编辑器 UI 不成为规则语义依赖。

一致性案例随对应能力提交，E 负责应用组合和发布维护。A 验证编辑数据层，B/C 验证预览与运行结果，UI 布局另行实现。低优先级能力保持状态，不从清单删除。订阅差异、状态、部署和维护分别引用 28、27、29、30，避免在路线文档复制稳定语义。

## 每阶段完成门槛

- 事实来源有源码路径或已有测试；
- 新增行为有成功、空值和失败 fixture；
- 取消、超时和资源清理有验证；
- SSR 无模块级可变请求状态；
- 文档中的每个“目标必须兼容”都有 Android 事实来源；若要标记 TypeScript 已验证，还必须有独立 fixture、golden 输出和可执行断言。
- 当前只完成文档时，应明确记录“TS runtime 未实现”或“fixture 待建立”，不能用源码路径替代 TypeScript 测试证据。
- 独立编辑器交付前，还要通过 JSON/JS 导入导出 round-trip、schema 字段覆盖、dirty/conflict 状态、fake 预览、capability error 和保存失败测试。
