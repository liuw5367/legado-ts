# 目标与边界

## 目标

建立独立的 TypeScript 书源运行时，使同一份书源能够被 Node 服务、SSR/Next.js 和带代理的 SPA 使用。第一版以普通声明式书源和静态 Header/Cookie/Token 为重点，复杂登录 UI、验证码和站点专用 WebView 流程保留能力标记，不阻塞核心库设计。

兼容目标是“结果和失败语义一致”，包括：

- 规则模式识别、规则链组合和替换顺序；
- 空值、缺字段、无结果、相对 URL 和重复数据的处理；
- 搜索、详情、目录、正文之间的上下文变量传递；
- JavaScript 书源的函数约定、绑定和返回值归一化；
- 请求参数展开、重定向、Cookie 和取消/超时边界。

## 核心库范围

- 书源 JSON 与 JavaScript 书源的解析、校验和规范化；
- `AnalyzeRule` 等价的规则解析与执行；
- `AnalyzeUrl` 等价的 URL 规则展开和请求描述生成；
- 搜索、详情、目录、正文的流程编排；
- Cookie、缓存、日志、JavaScript、HTML/JSON/XPath 解析的宿主接口；
- 规则诊断、测试输入和编辑器所需的结构化错误。

## 不放入核心库

- Android Activity、ViewModel、Room、DataBinding 和阅读器状态；
- 书架、阅读进度、下载文件持久化和 UI；
- 完整 Android WebView 替代实现；
- 验证码、多步骤登录和站点专用自动化登录。

## 目标包边界

```text
@legado/source-core
  schema / import / rule engine / URL description
  search-info-toc-content workflows / host ports

@legado/source-node
  HTTP / HTML / XPath / JSONPath / Cookie / cache adapters

@legado/source-next
  server-side facade / proxy boundary / browser-safe client facade

@legado/source-editor  (可选上层包)
  schema form / rule diagnostics / preview / import-export
```

第一阶段可放在一个 TypeScript package 中，以 `core` 和 `adapters` 目录隔离。只有规则语义和接口稳定后再拆包。

## 运行上下文约束

每次搜索、详情、目录或正文调用都创建独立的运行上下文。上下文可以包含当前书、章节、变量、Cookie 会话、缓存和 AbortSignal，但不能在 SSR 请求之间共享可变对象。书源级并发限制可以由宿主共享计数器实现，脚本 scope 和用户 Cookie 必须按会话隔离。

