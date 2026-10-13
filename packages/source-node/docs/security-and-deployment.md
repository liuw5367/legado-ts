# source-node 安全与部署边界

本文只记录当前 Node 宿主已经执行的限制，以及仍需应用或部署方案单独验收的边界。设计中的字段、平台策略和 DEP 用例不会被写成已存在的 Node 配置。

## 当前 Node 约束

网络请求先由 core 构造并校验 `RequestPlan`，再交给 `NodeNetworkHost`：

- 只允许 HTTP/HTTPS 和 GET/POST/HEAD；URL 凭据被拒绝。
- 默认拒绝 localhost、回环、私网、链路本地地址以及 DNS 解析到这些地址的目标；`allowPrivateNetworks` 是显式的 Node 选项，不能从书源字段隐式开启。
- 每次重定向都会再次检查地址。跨 origin 时清除原请求的 Authorization、Proxy-Authorization 和 Cookie，再按新目标 URL 读取它自己的 Cookie store，避免把源站登录材料带到新站点。
- `proxy` 当前返回 `capability-missing`；`dnsIp` 只能作为受控解析地址使用，仍受私网检查约束。
- 请求计划默认提供 15 秒超时、32 次请求、16 页、单响应 4 MiB、总响应 16 MiB、请求体 1 MiB和 5 次重定向。每次操作还可以通过 core budget 使用更小的限制；无效、非有限或非整数预算会被拒绝。
- 响应、重定向响应和请求体都按字节预算读取；超限时终止读取。Cookie 按 session 隔离，`cookieJar: false` 阻止保存响应 `Set-Cookie`。

QuickJS 使用独立 runtime，不执行 Node `eval`、`Function` 或 `node:vm`。当前默认单次预算为 1000 ms、16 MiB 内存、1 MiB 栈、512 KiB 输入、1 MiB 输出和 32 次 bridge 调用；取消、超时、序列化失败和预算超限都会形成可判别诊断，并释放 context。请求 bridge 的嵌套深度最多 3 层，`network-all` 最多 8 路并发；动态 source header 在嵌套请求中被跳过。这些是当前防护，不代表任意脚本都能安全访问任意宿主对象。

core 的 `compileSourcePattern` 还在规则编译前执行静态形态守卫：模式长度上限为 2048 个字符，未锚定的嵌套量词会被拒绝，非法模式返回稳定诊断。它减少正则资源耗尽风险，但不能替代脚本中断或整个请求预算。

字体、归档和本地书源读取同样执行资源限制：字体默认 16 MiB 输入和 4 个缓存条目；归档默认 64 个条目、单条目 8 MiB、总输出 32 MiB、压缩比 1000；来源目录默认 256 个普通 `.json`/`.js` 文件、单文件 4 MiB，并跳过符号链接。归档路径越界、加密 zip、未知格式和超出预算都会失败，不返回部分成功文件。

## 已登记的兼容取舍

目录链接、下一页链接等页面产出的 URL 中的 `{{...}}` 会按 Android 书源语义求值，与书源配置地址相同。这样可能让被篡改的页面触发带书源声明 Header/Cookie 的外连；保留它是为了维持来源兼容，收敛该行为需要在书源信任模型中决策。求值失败时请求以诊断失败结束，不发出未展开的字面量 URL。

日志、审计报告和应用导出必须由调用方脱敏 Cookie、Authorization、token、密码、签名参数、私有查询和正文。source-node 的兼容性报告只保存脱敏 hash、候选索引、主机、阶段和诊断代码，不把规则文本、Cookie、完整请求体或正文写入报告。

## 应用与平台责任

Node package 不提供 Web 用户隔离、加密运行状态、租约、JobStore、Worker、跨请求恢复或后台调度。这些事实分别由 `apps/reader-web` 当前文档、[任务执行归档](../../../docs/archive/job-and-execution.md) 和应用存储说明维护。浏览器、Edge、Serverless 函数时限、包体积、内存和临时磁盘必须按具体部署逐项验证；不能从 Node 默认值推导平台已具备同等能力。

Web 的用户 Cookie/变量加密、运行状态版本和清理见 [`reader-web` 实现](../../../apps/reader-web/docs/implementation.md)；Web 的环境变量和 Vercel 流程见[开发与部署](../../../apps/reader-web/docs/development-and-deployment.md)。当前部署仍在请求生命周期内完成搜索，持久刷新和长任务属于未实现目标。

跨请求调用不能依赖上一个函数实例中的 DOM、Cookie 或变量对象；应用若需要续接，必须保存 source 版本、书籍/目录身份和明确的缓存引用，并在下一次请求重新建立 session。Node package 不保证响应结束后继续运行任务，也不为外部写入生成幂等、租约或 `unknown` 状态。

## 部署验收设计（尚未执行）

下列项目来自旧的仓库级运行边界设计，保留作验收清单，不是当前 Node 已通过的结果：

| 编号 | 验收问题 | 当前事实 |
| --- | --- | --- |
| DEP-001 | 冷启动后导入至首章，状态能否从端口恢复 | 单次 Node session 可运行；跨请求恢复由应用设计 |
| DEP-002 | 两会话同源并发是否隔离 Cookie、变量和 trace | session 默认各自创建 Cookie store；应用缓存键仍需核验 |
| DEP-003 | 两实例写同章是否防止旧结果覆盖 | 不是 source-node 的持久写入能力 |
| DEP-004 | 客户端中断是否传播到所有资源 | Node 支持 signal；平台传播需部署验证 |
| DEP-005 | 大正文、内网重定向和死循环是否在预算内终止 | 当前请求、QuickJS 和归档护栏可单测；组合部署场景未执行 |
| DEP-006 | Edge 缺少 JS 时是否返回能力缺失 | 需要 Edge 适配器；Node package 不宣称 Edge 支持 |
| DEP-007 | 平台截止前是否得到明确失败或未知状态 | 由应用/平台协作验收，Node package 不拥有外部写入状态 |

兼容性验收用例、Android 对照和真实书源结果统一见[兼容性与验证](../../../docs/compatibility/README.md)。
