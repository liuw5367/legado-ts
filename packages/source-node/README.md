# @legado/source-node

`@legado/source-node` 是 Node 参考宿主。它把网络、Cookie、字符集、解析器、QuickJS、加密、字体、归档和并发能力装配到 [`@legado/source-core`](../source-core/README.md) 的规则与工作流端口中；它不保存书架、阅读进度或用户凭据，也不在浏览器中执行规则。

## 最小接入

仓库内的应用通过 workspace 使用本包。下面的例子从 JSON 书源中选择一个可执行候选，创建独立 session，运行一次搜索，并在所有路径关闭 session：

```ts
import { readFile } from 'node:fs/promises'
import { importSources, searchBooks } from '@legado/source-core'
import { createNodeSourceSession } from '@legado/source-node'

const text = await readFile('sources.json', 'utf8')
const candidates = await importSources(text)
const source = candidates.find((candidate) => candidate.status === 'ready')?.source
if (source === undefined) throw new Error('没有可执行的书源')

const session = createNodeSourceSession(source)
try {
  const result = await session.run((ports) => searchBooks(ports, {
    source: session.source,
    keyword: '示例关键词',
  }))

  if (result.status === 'success') console.log(result.value?.items ?? [])
  else console.error(result.status, result.diagnostics)
} finally {
  session.close()
}
```

`importSources` 只负责导入、规范化和诊断；没有 `ready` 候选时，应用应展示诊断或要求用户修正输入，不能把失败当成空搜索结果。`searchBooks` 返回 core 的 `RuntimeResult`，合法无结果是 `empty`，取消和缺少宿主能力分别是 `cancelled` 与 `capability-missing`。本例使用仓库中的 package 入口，不承诺一个已经发布的 npm 安装路径。

## 公开入口

`src/index.ts` 是本包公开导出的唯一清单，当前入口按职责分为：

- `createNodeSourceSession`、`NodeSourceSessionOptions`：装配 core session 与 Node 宿主。
- `NodeNetworkHost`、`NodeCookieStore`、`NodeCharsetCodec`、`NodeEncodingHost`、`NodeCryptoHost`：网络、Cookie、请求/响应字符集、编码和加密。
- `HtmlParserAdapter`、`JsonPathParserAdapter`、`XPathParserAdapter`、`QuickJSJavaScriptHost`、`SourceRuleHost`、`SourceRequestHost`：规则执行和请求 bridge。
- `NodeFontHost`、`NodeArchiveHost`、`NodeSourceFileHost`、`KeyedConcurrencyHost`：字体、gzip/zip 归档、受控书源文件桥和并发能力；RAR/7z 与 WebView/浏览器交互会明确返回能力缺失。
- `readSourcePath` 及来源目录限制：CLI 读取本地 `.json`/`.js` 书源。
- `buildStaticCompatibilityReport`、`runLiveCompatibility` 及相关类型：兼容性审计工具。在线审计必须显式运行，不属于默认测试。

详细的组合关系和资源所有权见 [宿主实现](docs/host-implementation.md)；网络、脚本、归档和部署限制见 [安全与部署](docs/security-and-deployment.md)；字体格式见 [字体映射](docs/font-decoding.md)；审计命令见 [兼容性审计](docs/compatibility-audit.md)。core 的端口、结果和工作流契约以 [core 文档](../source-core/README.md) 为准。

## 使用边界

本包依赖 Node API、`undici`、QuickJS 和本地宿主能力，Node 运行时是当前参考环境。浏览器、Edge、受限 SSR 或 Serverless 入口不能因为能导入 TypeScript 就视为具备相同能力；它们需要单独提供并验证宿主端口。应用负责用户范围、调度、持久化、展示、脱敏和删除清理；本包只负责一次 session 内的规则工作流和资源释放。

实现和测试以源码为准：[`src/index.ts`](src/index.ts)、[`src/source-session.ts`](src/source-session.ts) 以及 [`tests`](tests/)。跨端实现状态和 Android 对照证据见[兼容性与验证](../../docs/compatibility/README.md)。
