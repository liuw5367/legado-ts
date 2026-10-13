# 跨包与应用接入

source-core 的当前导出、结果契约和端口定义已经按包维护在 [`@legado/source-core`](../../packages/source-core/README.md) 文档中；本页只保留迁移期间仍未归位的 Node/应用接入事实。兼容范围和 Android 证据见[兼容性与验证](../compatibility/README.md)。

## 最小 Node 集成

下面的示例使用 workspace 中的两个 package 导入本地 JSON 书源，创建 Node session 并执行一次搜索。真实搜索会按书源规则请求网络；应用应在所有路径结束后关闭 session。

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

  if (result.status === 'success') console.log(result.value?.items)
  else console.error(result.status, result.diagnostics)
} finally {
  session.close()
}
```

`importSources` 只负责解析、规范化和诊断；应用确认候选后自行保存。`searchBooks` 返回 core 的 `RuntimeResult`，合法无结果是 `empty`，取消和宿主缺失分别是 `cancelled` 与 `capability-missing`。自定义网络、Cookie 或 JavaScript 能力时，应用通过 `createNodeSourceSession` 的选项或直接实现 [`WorkflowPorts`](../../packages/source-core/docs/host-ports.md) 注入宿主。package 不负责保存书架、阅读进度和用户凭据。

## 应用接入边界

应用持有书源配置及版本，package 接受一次调用使用的不可变 `NormalizedSource` 或 `SourceSnapshot`。用户编辑并保存书源后，新调用使用新版本；旧 session 必须先 `close()`，再用新快照创建 session。应用负责：

- 选择启用、分组和用户范围，并调用 `discoverBooks`、`searchBooks`、`loadBookDetails`、`loadTableOfContents` 或正文入口；
- 根据 `RuntimeResult.status`、`value`、`diagnostics` 和 `trace` 决定展示、重试、取消和保存；
- 通过 `ContentStore`、Repository 或应用文件存储提交书架、正文、阅读进度和用户凭据；
- 对 reader-cli/reader-web 自己的用户状态、鉴权和删除清理负责。

多源 fan-out、进度事件和书源检测（`ReaderApplication.search` / `ReaderApplication.checkSources`）属于应用层，不是 source-core 的统一门面。CLI 现有状态和检测行为见 [`reader-cli` 实现文档](../../apps/reader-cli/docs/implementation.md)；Web 的导入确认和存储边界见 [`reader-web` 实现文档](../../apps/reader-web/docs/implementation.md)。

## 订阅、导入和应用操作

典型操作从导入或订阅开始，经搜索、详情、目录到正文。source-core 的导入、导出、身份和订阅计划见[codec 与订阅](../../packages/source-core/docs/codec-and-subscriptions.md)；订阅刷新只计算 diff 和提交计划，不下载后直接写入应用存储，也不负责调度。

1. 应用把原文交给 `importSources`，展示候选、冲突和诊断；用户确认后应用写入自己的存储。
2. 应用读取书源快照，调用搜索或发现；打开书籍后调用详情和目录。
3. 应用构造章节身份和正文缓存端口，调用正文或 cache-first 正文入口，并根据条件写结果。
4. 订阅到期时，应用调度 `refreshSubscription`，确认 `commitPlan` 后自行提交差异。

## Node 与框架接入

当前参考宿主是 `@legado/source-node`。reader-cli 与 reader-web 调用同一组 source-core 公开入口，应用只负责用户范围、调度、展示和持久化，不各自解释规则。Node 的 session、规则宿主、请求宿主、解析器和资源边界将在 T05 的 source-node 文档建立后集中说明；在迁移完成前，公开入口以 `packages/source-node/src/index.ts` 为准。

SSR、Next.js、Edge 等受限环境的宿主能力判断见[运行边界](../operations/runtime-security-and-deployment.md)；Web 当前实现入口见 [`reader-web` 实现文档](../../apps/reader-web/docs/implementation.md)。

## 维护约定

- 原始书源格式版本、规则语义版本和 package API 版本分开记录；规则行为修正若会改变已有书源结果，需要兼容案例和迁移说明。
- 未识别的书源字段由 codec 保留；导入成功不能推断规则在目标宿主可执行，状态以[兼容性状态](../compatibility/status.md)为准。
- 公开入口都应有成功、空结果、规则错误、宿主失败、取消和资源清理样本；相关测试位于 `packages/source-core/tests/` 与 `packages/source-node/tests/`。
