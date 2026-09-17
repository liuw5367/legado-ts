# 运行边界与部署验收

本章定义 Web 宿主目标策略，核对日期为 2026-09-16。安全拒绝必须返回 policy-denied 及具体能力，不把与 Android 的策略差异伪装成规则解析失败。

## 运行环境选择

Node 是参考宿主；浏览器只承载编辑及领域结果，Edge 按入口逐项验证。Vercel 官方推荐 Node，Edge 限制动态代码执行；最新页面还说明 Next.js 16.3 起不支持路由配置 runtime=edge。项目尚未选择 Next.js 版本，不能把此说明当作本项目已配置行为。[Vercel Edge 文档](https://vercel.com/docs/functions/runtimes/edge)

平台函数时长、内存、包体积和请求/响应限制随方案与运行时变化。部署报告必须记录实际配置及核对日期，不在核心规则中硬编码平台套餐数值。[Vercel Functions 限制](https://vercel.com/docs/functions/limitations)

Node API 可用不代表脚本安全；node:vm 不是安全隔离机制。worker 是资源和终止边界，也不能单独证明不可信代码无法访问宿主。[Node vm 文档](https://nodejs.org/api/vm.html)

每次联网或脚本操作都要先形成不可变预算：

```ts
interface OperationBudget {
  deadlineMs: number
  maxRequests: number
  maxPages: number
  maxResponseBytes: number
  maxTotalBytes: number
  maxScriptMemoryBytes: number
  maxScriptTimeMs: number
}
```

缺失、`NaN`、`+Infinity`、`-Infinity`、非正值或已经过期的预算必须在创建上下文前拒绝；signal、单请求超时、单源总预算和平台截止时间分别记录，不能互相覆盖。

## 脚本实现参考与决定

核对两个项目的实现机制：

| 参考 | 已见机制 | 本项目采用的设计原则与限制 |
| --- | --- | --- |
| [quickjs-emscripten runtime](https://github.com/justjake/quickjs-emscripten/blob/main/packages/quickjs-emscripten-core/src/runtime.ts) 与 [Asyncify runtime](https://github.com/justjake/quickjs-emscripten/blob/main/packages/quickjs-emscripten-core/src/runtime-asyncify.ts) | 独立 runtime、内存/栈限制、中断回调、显式 dispose；异步变体独立处理宿主等待 | Node 参考实现优先评估嵌入式解释器加受控桥接，保留脚本同步外观；不可将 JS Promise 暴露给原有同步 java.ajax 调用 |
| [isolated-vm reference_handle](https://github.com/laverdet/isolated-vm/blob/main/src/module/reference_handle.cc) 与 [isolate_handle](https://github.com/laverdet/isolated-vm/blob/main/src/module/isolate_handle.cc) | 隔离对象引用、复制/引用传输及 isolate 管理 | 只传序列化数据和最小能力，不传 Node 对象；原生扩展的打包和运行要求更强，保留为替代方案，不作为 Edge 默认依赖 |

这是一项有证据的候选方向，不是已验证的引擎选型。本轮未安装或运行上述引擎。阶段 B 负责人必须通过同步网络返回、嵌套规则回调、取消等待、无限循环终止、句柄清理和 Rhino 返回值对照后，才能固定依赖版本。同步 `java.ajax/connect` 是完整旧式 JS 兼容的前置条件，不是可在实现后再忽略的优化；若 Node/Edge 无法安全提供同步网络外观，必须改为独立 JS 执行服务，或由用户审核后缩小 JS 兼容范围。失败只阻塞 JS 宿主验收，codec 和纯规则仍可实现。

桥接调用携带 operationId、sessionId 和 sourceId。等待 HTTP 期间宿主事件循环仍可处理取消；宿主不得在同一个暂停中的解释器上重入，嵌套规则执行使用受控调用栈或独立上下文，并共享同一总预算。远端响应回到已关闭操作时丢弃结果，不恢复脚本或写缓存。

## 网络及内容策略

| 风险 | 校验位置 | 结果 |
| --- | --- | --- |
| SSRF、DNS 重绑定、重定向到内网 | HTTP adapter 在解析地址、实际连接及每次重定向前校验；覆盖 IPv4/IPv6、回环、私网和云元数据地址 | 拒绝连接；不能只检查最初 URL |
| 登录头/Cookie 跨域 | 根据实际目标域与 Cookie 属性处理每跳请求；显式跨域凭据仍受会话授权 | 删除未授权凭据或拒绝，记录安全策略差异 |
| proxy/dnsIp 绕过策略 | 网络适配器验证代理及覆盖地址；不允许源绕过出口策略 | capability-missing 或 policy-denied |
| 无限分页、重试及导入展开 | operation 共享页数、请求数、深度与截止时间预算 | budget-exceeded，目录不得保存为完整目录 |
| 超大响应、压缩炸弹、归档路径越界 | 流式字节计数、解压后计数、归档项数及路径验证 | 终止并释放流，不返回部分成功文件 |
| 脚本/正则 CPU 耗尽 | 可终止执行环境和总预算；主事件循环同步正则不能靠 Promise 超时中断 | timeout 或 budget-exceeded |
| 返回 HTML 中的脚本及私有地址 | 核心保留规则兼容文本；应用呈现层执行 HTML 清理与资源地址策略 | 不直接把书源 HTML 注入页面 |
| 日志泄露 | 输出前脱敏头、查询参数、body、脚本绑定与异常 | trace 只返回受控摘要 |

宿主必须显式提供 `deadlineMs`（绝对毫秒截止时间）、`maxRequests`、`maxPages`、`maxResponseBytes`、`maxTotalBytes`、`maxScriptMemoryBytes`、`maxScriptTimeMs`。这些是目标策略字段，没有虚构的现有默认值；缺失或非正有限值时拒绝创建联网执行上下文。适配器配置须短于平台限制，并在部署报告中给出数值。脚本跳过源限流不能跳过这些总预算。

运行结果至少能区分 `policy-denied`、`budget-exceeded`、`capability-missing`、`timeout`、`cancelled`、`stale`、`upstream-error` 和 `storage-error`，并包含 `stage`、`operationId`、安全 message、是否可重试和 cleanup。取消先停止新请求/脚本/分页，再等待已启动资源释放；客户端断开不能直接当作 cleanup 完成。

## 不可信书源与数据边界

书源 JSON、规则文本、`mainJs`、`bodyJs`、订阅响应和远端 HTML 都是不可信输入。它们只能访问当前 operation 显式注入的 `RuntimeHost` 能力，不能读取 Node 进程、环境变量、其他用户的 Cookie/变量/缓存、真实文件路径或数据库 client。应用返回浏览器前还必须对正文 HTML、资源地址和调试信息执行呈现层清理。

威胁处理至少覆盖：源 URL 和每次重定向的 SSRF/DNS rebinding、代理/DNS 绕过、脚本和正则资源耗尽、压缩/归档炸弹、跨用户缓存键碰撞、Cookie/Authorization 泄露、HTML 注入、日志和导出泄露。`policy-denied`、`budget-exceeded`、`capability-missing` 与规则解析失败必须区分。

脱敏规则应在 adapter 中集中实现：Cookie、Authorization、密码、token、服务端 URL 查询凭据和私有请求体默认删除或掩码；`rule`、body 和 HTML 只保留受限摘要。任何 fixture、任务诊断、审计记录和 API 错误都不得通过字段名变化绕过该策略。

## Serverless 状态与调用

不可变解析配置可复用；用户 Cookie、变量、正文引用和版本必须由明确会话的存储端口读取。实例内存和临时磁盘只作优化，冷启动或换实例不能丢失已确认的用户状态。跨实例 token、限流和互斥不能只用进程内 Map。

一次用户操作可经过多次 HTTP 调用；通过源版本、bookKey、tocRevision 及明确的响应缓存引用续接，不能依赖前一次函数的 DOM 对象。infoHtml/tocHtml 如由服务端保留，引用须含会话、源版本、最终 URL 和过期时间，不交给浏览器任意回传后作为可信页面。

不承诺响应结束后继续执行长批量任务。阶段 C 先限制一次调用的源数、页数和预算，返回明确未处理项目；持久后台调度属于应用部署设计，需要独立评估。

## 实际部署验收

| 案例 | 必须观察的结果 |
| --- | --- |
| DEP-001 冷启动后导入至首章 | 从 package 公开入口执行，所有状态可从端口恢复 |
| DEP-002 两会话同源并发 | Cookie/变量/trace 不交叉，缓存键含会话 |
| DEP-003 两实例写同章 | 旧 token 被拒绝，不发生后完成者覆盖新版本 |
| DEP-004 客户端中断 | 已验证平台信号能传播；否则截止时间仍停止工作，报告该限制 |
| DEP-005 大正文、重定向内网、脚本死循环 | 在预算内拒绝或终止，宿主继续响应其他操作 |
| DEP-006 Edge 缺 JS | 返回 capability-missing，静态入口可用；不自动转发私有会话到未授权服务 |
| DEP-007 上游超时及平台截止 | 先于平台强制终止返回可识别失败，或记录中断结果未知，无成功事件 |

本章案例均为验收设计，当前没有实际部署结果。
