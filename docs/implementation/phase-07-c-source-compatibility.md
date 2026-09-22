# 任务 07-C：真实书源规则兼容性审计

07-C 在 07-A/07-B 的离线测试之上，使用 `fixtures/source` 的全部真实候选书源生成兼容性报告。它不把网站暂时不可访问误判为规则不支持，也不把含敏感请求头的配置直接发送到公网。

## 命令

```bash
pnpm run test:source:compat:static
pnpm run test:source:compat:live -- --keyword "我本无意成仙" --report /private/tmp/source-compatibility.json
```

静态命令只读取四个 fixture 文件，报告规则编译、能力和请求形态，不访问公网。它是硬门禁：所有候选必须完成导入，所有已声明的非空规则必须完成静态编译；空规则组、缺少搜索/目录/正文等可选配置不算解析失败。live 命令才执行搜索；搜索命中规范化后的目标书名后，继续执行详情、目录和第一章正文，目录和正文最多读取 3 页。

开发时可用 `--max-sources 1` 或 `--timeout-ms 5000` 做小范围验证。live 是显式公网命令，不加入默认 `pnpm test`。

## 报告

报告只保留文件/候选索引、脱敏 source hash、规则定义 fingerprint、主机名、阶段、诊断码和请求计数，不保存规则全文、正文、Cookie、Authorization、私有查询参数或 JavaScript 返回值。fingerprint 忽略显示名称和排序/启用等管理字段，只有规则、请求定义等功能配置一致时才归为同一份书源定义；名称本身不参与判重。

书源状态分为：

- `fully-supported`：搜索命中、详情、目录和正文均成功；
- `partial`：命中目标但后续只完成部分阶段；
- `rule-unsupported`：规则、JavaScript、解析器或宿主能力未覆盖；
- `external-failed`：DNS、超时、HTTP 或站点暂时失败；
- `search-no-target`：搜索完成但没有精确命中目标书；
- `blocked-sensitive-config`：无效地址、WebView 或敏感请求配置被安全策略阻断。

每个源独立隔离变量、Cookie、请求预算和 JavaScript context；全局最多 4 个并发，同一主机最多 1 个并发。不自动登录、不写远程状态、不重试非幂等请求。

## 当前离线验收

`pnpm run test:source` 覆盖真实 HTML 书源统一宿主全流程、JSON/XPath/JavaScript 规则、URL options、位置选择器、模板页码算术、字体/加密既有测试以及 07-A/07-B 文件入口测试；其中 07-B 还断言全部真实候选可静态导入且全部声明规则可编译。导入候选额外带有加载态 `sourceUuid`，以及用于判定同一份功能定义的 `sourceFingerprint`；`bookSourceUrl` 仍保留为兼容层 `sourceId`，UUID 不写回源文件。默认 `pnpm test` 仍不依赖公网；Node 网络测试若在受限沙箱中运行，可能因无法监听本地测试端口而需要在允许本地 socket 的环境中执行。
