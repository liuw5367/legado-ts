# 阶段 E-2：应用接入、部署验证与 package 维护

应用层只组织书源操作：选择书源、创建调用上下文、调用 package、展示进度和诊断、保存结果。书架和阅读器的完整需求以后单独设计。本章定义 SPA、Next.js 与 React Router 可以共享的服务端边界，以及 package 发布前的验证方式。

本阶段依赖 [阶段 E-1 的持久化、订阅与检测边界](phase-e-storage-and-check.md)。先完成用户归属、Repository、CAS、检测状态和任务存储，再接入框架入口；框架层不重新实现保存或规则处理。

## 一个服务端入口服务所有前端形态

先实现与框架无关的请求处理器，再把它接到 Node 服务、Next.js route handler 或 React Router 服务端入口。处理器应：

1. 验证 action、书源身份、书籍和章节身份、页码及用户权限；从可信存储读取书源版本，不接受浏览器传来的任意 `RuntimeHost` 或脚本宿主对象。
2. 按用户或匿名会话创建 `requestId`、`AbortSignal`、Cookie 视图、变量视图、限流器和宿主能力集合；设置目标地址策略、响应大小和操作总时长。
3. 调用 [公开 package 入口](../guides/package-usage.md)；转发可安全展示的进度与结构化错误，保留书源级失败与流程级失败的区别。
4. 在确认调用仍有效、书源版本未变化后提交目录或正文等变更；请求结束、客户端断开、超时和异常都关闭脚本 scope、网络响应、监听器与临时状态。

SPA 只通过服务端接口调用书源。Next.js 使用 route handler 承载书源请求；React Router 框架模式可在服务端 loader 读取，在 action 处理导入或编辑提交。两者都调用同一处理器，每次请求创建自己的运行上下文，页面组件只消费脱敏 DTO。导入和编辑预览属于有权限的独立动作，不能复用公开读取接口接受任意 URL 或任意脚本。接口 DTO、错误码和测试 fixture 应共享同一事实源。框架入口依据 [Next.js route handler 文档](https://nextjs.org/docs/app/api-reference/file-conventions/route) 与 [React Router 数据加载文档](https://reactrouter.com/start/framework/data-loading) 在实施时再次核对。

## Node 先作为参考宿主

最小 Node 部署验证已经属于 C；本阶段复用该证据并增加真实应用入口、产物安装和版本回退。平台事实以 [运行边界与部署验收](../operations/runtime-security-and-deployment.md) 为准，版本与发布以 [package 维护与迁移证据](../operations/package-maintenance.md) 为准。

优先在 Node 运行时完成书源宿主，再选择页面框架。Vercel 的 [Node.js Functions 文档](https://vercel.com/docs/functions/runtimes/node-js)说明该运行时提供 Node.js API；[Next.js 路由运行时文档](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config)也把 `nodejs` 作为默认运行时。这个选择服务于需要受限脚本执行、解析器和可能的浏览器适配器的书源，不意味着 Node 可以安全地直接 `eval` 不可信脚本。脚本仍须经过独立隔离与资源限制。

Edge 按入口验证；具体限制及核对日期见[运行边界与部署验收](../operations/runtime-security-and-deployment.md)。缺能力时明确返回诊断，只有应用已配置且授权目标宿主时才转发，不能自动向其他服务传送会话凭据。

[Vercel 的 React Router 文档](https://vercel.com/docs/frameworks/frontend/react-router)说明其可用于 SSR 与 SPA 模式，并提供 Vercel Preset。选择 React Router 时在服务端入口复用同一处理器；选择 Next.js 时在 route handler 复用它。框架选择不改变 `BookSource`、规则解析、书籍结果和保存 token 的定义。

## 验证层级

| 层级 | 从哪里调用 | 必须证明什么 |
| --- | --- | --- |
| codec 与规则 | package 公开入口 | 原文保留、规则结果、空值和诊断与 fixture 一致 |
| 单书源流程 | fake HTTP 加真实规则引擎 | 请求、解析、结果、取消、资源清理与 Android golden 对照 |
| Node 宿主 | 真实服务端入口与本地可控 HTTP 站点 | Cookie 隔离、重定向、超时、bytes、错误 DTO 和保存边界 |
| 应用接入 | SPA/SSR 页面经服务端处理器 | 从导入到搜索、详情、目录、章节的调用顺序和版本保护 |
| 目标部署 | 实际 Node 或 Edge 构建与运行环境 | 能力报告与运行结果一致，缺失能力不会伪造成功 |

测试 ID 和证据等级使用 [一致性测试基线](../quality/conformance-tests.md)。设计新增的行为，例如没有 Android 执行证据的段评写入，单独建立 Web 目标测试，不作为 Android 等价 golden。正式发布前对已支持的书源能力运行全部对应 fixture，并对目标部署执行最小端到端操作；尚未实现的能力在 [兼容性矩阵](../quality/compatibility-matrix.md) 中保留状态。

## 版本、发布与回退

维护时分别记录原始书源格式、规则语义和 package API 的版本。修复规则引擎前先补能重现问题的输入与 Android 结果；若新行为改变已有书源结果，提供版本化兼容路径和迁移说明。package 的导出入口与错误码应稳定，内部解析器、HTTP 客户端或框架适配器可以替换，只要同一 fixture 保持通过。

发布顺序为：固定兼容矩阵与 fixture，构建 package，运行公开入口测试与目标宿主测试，更新版本和变更说明，再让应用升级。若部署后发现回归，可以把应用依赖退回上一已验证的 package 版本，并恢复同版本的规则语义与缓存键；导入的书源原文和未知字段不能因回退丢失。当前仓库只有文档，尚不具备可发布的 runtime 或真实部署验证结果。
