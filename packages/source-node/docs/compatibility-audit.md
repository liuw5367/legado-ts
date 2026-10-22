# 真实书源兼容性审计

审计在离线导入/解析测试之上运行，用于区分规则不支持与站点暂时不可访问。它不会把敏感请求配置或正文写入报告。实现入口位于 [`src/source-compatibility.ts`](../src/source-compatibility.ts) 与 [`src/source-compatibility-live.ts`](../src/source-compatibility-live.ts)，状态和证据归属见[兼容性与验证](../../../docs/compatibility/README.md)。

## 命令

```bash
pnpm run test:source:compat:static
pnpm run test:source:compat:live -- --keyword "我本无意成仙" --report /private/tmp/source-compatibility.json
```

静态审计读取 `fixtures/source/collection` 和 `fixtures/source/single` 下的全部 JSON fixture，检查导入、声明规则编译、能力和请求形态，不访问公网。在线审计必须显式执行，按目标书名继续请求详情、目录和首章正文，并设置来源数与单源时间限制；它不属于默认 `pnpm test`。

静态报告同时给出 `uncompiledRules`、`knownUncompiledRules`、`unexpectedUncompiledRules` 和 `staleKnownBrokenRules`。`fixtures/corpus/manifest.json` 中登记的规则文本错误只有在路径、源名、字段、诊断码和规则 hash 全部匹配时才计入 `knownUncompiledRules`；新增编译失败、白名单过期或规则被意外修好都会进入异常计数并使命令以非零退出。当前语料的 5 条 `unbalanced-rule` 已全部匹配白名单，因此静态审计命令可以成功退出，但这 5 条仍是源文本问题，不能当作 TypeScript 已支持该规则。

## 报告与状态

报告仅保存文件/候选索引、脱敏 source hash、功能定义 fingerprint、主机名、阶段、诊断码和请求计数，不保存规则全文、正文、Cookie、Authorization、私有查询参数或脚本返回值。

单源状态为：

- `fully-supported`：搜索命中、详情、目录和正文均完成；
- `partial`：命中目标但后续阶段只有部分完成；
- `rule-unsupported`：规则、脚本、解析器或宿主能力未覆盖；
- `external-failed`：DNS、超时、HTTP 或站点暂时失败；
- `search-no-target`：搜索成功但没有精确命中目标书；
- `blocked-sensitive-config`：安全策略阻止了地址、WebView 或敏感请求配置。

每个来源隔离 Cookie、变量、请求预算和 JavaScript context；全局并发与同主机并发均受审计命令限制。不自动登录、不写远程状态、不重试非幂等请求。

## 验收边界

静态通过只代表规则可以导入和编译；在线通过也只代表指定时间、指定站点和指定宿主下的路径成功。Android 对照、跨部署环境和长期站点可用性仍需分别登记到兼容矩阵。

## 2026-10-22 P13 回归记录

最终回归同时保留实现、TypeScript 执行和 Android 前置条件三个结果：

- `node scripts/run-source-conformance-typescript.mjs` 对六条离线 workflow fixture 逐条输出实际 `result`，六条均与各自 `expected.json` 一致（`6/6 pass`）。
- `node scripts/compare-source-conformance.mjs` 发现六条 Android 输出均缺失，因此报告 `typescript=pass`、`android=not-run`、`comparison=not-run`；只有加 `--require-android` 才以退出码 2 阻断。
- `node scripts/run-source-conformance-android.mjs` 检查到外层 Android 项目有 Gradle wrapper，但没有逐 fixture adapter、`local.properties` 或 golden 输出，返回 `status=not-run`，不把普通 Android 单测转换成跨端结果。
- `pnpm test:source:compat:static` 的当前摘要为 943 个候选源、20,231 条规则、20,226 条编译成功、5 条已知源文本错误，意外未编译和过期白名单均为 0。

因此 P13 的 TypeScript 实现与审计出口已完成；Android 同输入验证仍是明确受阻项，必须提供读取 `fixtures/conformance/manifest.json` 并写出 `runner-result.schema.json` 的 Android adapter 后才能将对应条目标为双端通过。
