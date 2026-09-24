# 目标与边界

## 目标

建立独立的 TypeScript 书源运行时，使同一份书源能够被 Node 服务、SSR/Next.js、React Router 服务端入口和带代理的 SPA 使用。完整登记 `BookSource` 的声明式、JavaScript、发现、媒体、登录、交互等能力。复杂登录、验证码和站点专用 WebView 可以低优先级实施，但任何能力是否最终放弃都需要单独说明收益、架构代价和兼容影响，并由用户审核。

兼容目标是“结果和失败语义一致”，包括：

- 规则模式识别、规则链组合和替换顺序；
- 空值、缺字段、无结果、相对 URL 和重复数据的处理；
- 搜索、详情、目录、正文之间的上下文变量传递；
- JavaScript 书源的函数约定、绑定和返回值归一化；
- 请求参数展开、重定向、Cookie 和取消/超时边界。

## 核心库范围

- 书源 JSON 与 JavaScript 书源的解析、校验和规范化；
- 发现分类的解析及选定分类后的列表流程；
- `AnalyzeRule` 等价的规则解析与执行；
- `AnalyzeUrl` 等价的 URL 规则展开和请求描述生成；
- 搜索、详情、目录、正文的流程编排；
- Cookie、缓存、日志、JavaScript、HTML/JSON/XPath 解析的宿主接口；
- 规则诊断、测试输入和编辑器所需的结构化错误。
- 面向上层应用的公开调用入口、结果和变更契约。

## 不放入核心库

- Android Activity、ViewModel、Room、DataBinding 和阅读器状态；
- 书架、阅读进度、下载文件持久化和 UI；
- Android 界面组件的逐项移植；其承载的书源行为仍需在能力清单中登记，并决定 Web 宿主接口。

## 仓库包边界（现状）

```text
@legado/source-core          已实现
  codec / rules / runtime / workflows / subscription
  公开入口与端口类型

@legado/source-node          已实现
  HTTP / HTML / XPath / JSONPath / Cookie / charset
  QuickJS / font / archive / crypto / concurrency
  SourceRuleHost / SourceRequestHost / 兼容性 CLI

@legado/reader-cli           已实现（apps/reader-cli）
  TUI 阅读器、书架、本地 JSON 存储
```

以下包名是历史职责视图，**当前仓库不存在**：`source-next`、`source-editor`、`source-artifacts`（见 [归档](../archive/README.md)）。框架适配器只转换请求和结果；SPA、Next.js、React Router 不各自拥有规则层。Node 参考宿主已验证；Edge 的适用能力按 [运行边界](../operations/runtime-security-and-deployment.md) 判断。完整 JS 兼容不能用“TypeScript 可构建”替代实际执行证明。

完整能力的优先级和待审核项目见 [书源能力清单与审核决策](../standard/capability-inventory.md)。公开入口与上层调用顺序见 [独立 package 的调用契约](../implementation/package-usage.md)。应用层文档只描述书源选择、调用、结果保存和错误处理；书架、阅读器与阅读进度以后单独设计。

## 能力归属

| 能力 | 核心入口 | 宿主端口 | 应用服务或适配器责任 | 当前范围 |
| --- | --- | --- | --- | --- |
| 声明式规则、JavaScript 规则 | `source-core` 规则求值和流程 | `JavaScriptRuntime`、解析器、`RuntimeHost` | 选择宿主能力并映射诊断 | 核心兼容目标 |
| 网络、Cookie、缓存、变量 | 请求计划和流程状态机 | `HttpClient`、`CookieStore`、`CacheStore`、变量端口 | 按用户、源和会话隔离持久数据 | 核心端口，宿主实现 |
| 图片、音频、视频、文件 | 资源结果与保存令牌 | `ResourceStore`、解密/字节能力 | 资源权限、缓存和下载策略 | 已登记，按宿主验证 |
| 登录、验证码、动态认证 | 登录规则和认证状态 | `login-ui`、浏览器或授权宿主 | 页面交互、凭据保存和会话恢复 | 静态能力优先，交互能力待验证 |
| 书源事件、自定义按钮、播放器 | 版本化动作/事件结果 | `interactive-ui`、浏览器和应用回调 | UI 展示、权限和用户确认 | 字段已登记，协议待验证 |
| 书源保存、删除、检测、订阅 | `SourceApplicationService`（目标设计，未实现） | Repository、SecretStore、JobStore | 用户范围、版本断言、事务和副作用 | 应用边界，不属于规则解析器 |

核心只产生可序列化结果、诊断和变更；DOM 节点、脚本句柄、Cookie 原文和凭据引用只能存在于运行上下文或受控宿主端口。表中“待验证”表示尚未有执行证据，不表示可以静默删除该能力。

## 运行上下文约束

每次发现、搜索、详情、目录或正文调用都创建独立的运行上下文。上下文可以包含当前书、章节、变量、Cookie 会话、缓存和 AbortSignal，但不能在 SSR 请求之间共享可变对象。书源级并发限制可以由宿主共享计数器实现，脚本 scope 和用户 Cookie 必须按会话隔离。

请求视图与持久会话分开：请求结束释放视图，不删除用户 Cookie/源变量。所有权、版本和原子提交以 [状态契约](../standard/state-and-effects.md) 为准。订阅刷新属于源处理目标，应用仅负责调度与保存；RSS 实体、书架、阅读器和账户产品仍不在本轮范围。
