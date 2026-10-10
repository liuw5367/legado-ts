# 真实书源兼容性审计

审计在离线导入/解析测试之上运行，用于区分规则不支持与站点暂时不可访问。它不会把敏感请求配置或正文写入报告。

## 命令

```bash
pnpm run test:source:compat:static
pnpm run test:source:compat:live -- --keyword "我本无意成仙" --report /private/tmp/source-compatibility.json
```

静态审计读取 `fixtures/source/collection` 和 `fixtures/source/single` 下的全部 JSON fixture，检查导入、声明规则编译、能力和请求形态，不访问公网。在线审计必须显式执行，按目标书名继续请求详情、目录和首章正文，并设置来源数与单源时间限制；它不属于默认 `pnpm test`。

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
