# 迁移实施顺序

## 当前交付状态

当前交付物是行为规格和迁移设计文档，不包含 TypeScript runtime、Node adapter、独立编辑器或 Android 对照 golden。文档中的接口、兼容性矩阵和测试样例是后续实现的约束，不能据此宣称 TypeScript 已经兼容。

现阶段已经有 Android/Kotlin 源码和部分 Android/Web 测试作为事实依据，但仍需要把关键行为整理成脱敏 fixture，并为每个 fixture 建立 TypeScript 自动断言。只有两者都存在，才可以把兼容矩阵中的 TS 状态改为已验证。

## 阶段一：行为基线

先完成规则、URL 和四流程的 Android fixture，记录输入 body、规则文本、上下文变量、输出 JSON、异常类型和日志阶段。fixture 必须脱敏，不保存真实 Cookie、Token 或账号。

行为基线还必须记录每条流程的状态转换、请求启动与完成顺序、缓存命中与写入、持久化变更、事件/回调顺序、取消出口和资源清理结果。只有结果 JSON 没有这些处理记录时，不能证明流程兼容。

## 阶段二：纯规则核心

按以下依赖顺序实现：

1. 平衡分隔器：括号、方括号、引号和转义；
2. SourceRule 模式识别；
3. Default DOM 选择、链、文本/属性输出；
4. 索引、范围、排除和 `&&/||/%%`；
5. XPath、JSONPath、Regex；
6. `$n`、`@put/@get`、`{{}}` 和替换；
7. `getString`、`getStringList`、`getElement`、`getElements` 归一化。

每一步都必须先通过对应 conformance fixture，再进入下一层。

## 阶段三：URL 和宿主端口

实现 URL 规则展开与请求描述，不在核心中绑定 fetch、axios、undici 或某个 DOM 库。同步补齐 `VariableStore`、`JavaApi`、`SourceApi` 和 capability 接口，明确每个端口的输入、输出、错误和所有权。Node adapter 先实现普通 HTTP；WebView、代理、DNS 覆盖和复杂认证以能力接口增加。

## 阶段四：四条流程

依次实现搜索、详情、目录、正文。流程代码只调用规则核心和 host port，不重新实现字段规则。每个流程要固化输入 DTO、状态机、请求和解析顺序、空值、分页、取消、超时、缓存、持久化、回调和重复数据；每个阶段都要有成功、部分失败和清理后的输出。

## 阶段五：JS 源

实现配置抽取、脚本沙箱、返回值 JSON 归一化、marshaller 和 [JavaScript 书源宿主 API](11-runtime-host-interfaces.md#javascript-书源宿主-api)。先支持普通函数和静态变量，再增加批量；复杂登录和 WebView 作为可选 adapter，但登录函数配对、静态登录头和 capability error 必须先有 fixture。

## 阶段六：应用和编辑器

Node API 作为 SPA/Next.js 代理边界；编辑器复用 schema、规则词法解析、诊断和 preview session。只有核心结果稳定后，才拆分 `@legado/source-core`、Node adapter 和编辑器包。

阶段六必须同时完成一致性测试和编辑器验收：使用 `15-conformance-tests.md` 中的全部用例 ID 建立 fixture、golden 和 TypeScript 断言；使用 `16-source-editor.md` 中的会话状态建立导入导出 round-trip、预览、dirty、conflict、保存失败和 preserve-only 字段测试。没有这些证据时，只能交付设计文档，不能把实现标记为兼容。

## 每阶段完成门槛

- 事实来源有源码路径或已有测试；
- 新增行为有成功、空值和失败 fixture；
- 取消、超时和资源清理有验证；
- SSR 无模块级可变请求状态；
- 文档中的每个“目标必须兼容”都有 Android 事实来源；若要标记 TypeScript 已验证，还必须有独立 fixture、golden 输出和可执行断言。
- 当前只完成文档时，应明确记录“TS runtime 未实现”或“fixture 待建立”，不能用源码路径替代 TypeScript 测试证据。
- 书源编辑器还要通过 JSON/JS 导入导出 round-trip、schema 字段覆盖、dirty/conflict 状态、fake 预览、capability error 和保存失败测试，才能进入独立编辑器实现阶段。
