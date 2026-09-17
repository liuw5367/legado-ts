# 书源编辑器规划

## 现有基础

`modules/web/src/views/SourceEditor.vue` 已经提供 JSON 书源和 JavaScript 书源两种模式；JSON 编辑器由 `bookSourceEditConfig.ts` 驱动，当前覆盖基础、搜索、详情、目录、正文和段评配置中的一部分；JS 编辑器支持源选择、新建模板、打开、导出、刷新、保存、未保存修改确认和移动端布局。`modules/web/tests/sourceEditor.test.js` 已覆盖部分这些行为。编辑器现状不能被当作完整 `ReviewRule` schema 或独立 runtime 的证明。

现有编辑器依赖 Android API 的保存/调试接口，不能直接成为独立 npm 编辑器。迁移时复用其字段组织和交互约定，但把运行时语义放入 `source-core`。

## 字段覆盖边界

`modules/web/src/source.d.ts` 中的 `ReviewRule` 比当前 `bookSourceEditConfig.ts` 的表单项更完整。迁移时必须区分“可编辑”“只读保留”和“目标新增”，不能因为表单没有入口就丢弃字段。

| 字段范围 | 当前 Web 表单 | 独立编辑器目标 |
| --- | --- | --- |
| `ruleReview.enabled`、摘要 URL/列表/段落索引/数量/数据 | 已覆盖 | 可编辑、校验并预览 |
| 详情 URL/下一页/列表/ID/头像/昵称/徽章/内容 | 已覆盖 | 可编辑、校验并预览 |
| 回复 URL/列表/ID/头像/昵称/徽章/内容 | 已覆盖 | 可编辑、校验并预览 |
| `reviewUrl`、`avatarRule`、`contentRule`、`postTimeRule` | 当前表单未覆盖 | 导入导出保留，确认语义后增加编辑入口 |
| `voteUpUrl`、`voteDownUrl`、`postReviewUrl`、`postQuoteUrl`、`deleteUrl` | 当前表单未覆盖 | 导入导出保留，标记为交互或认证能力 |
| 书源未知字段和完整 `mainJs` | 当前页面不能证明全部保留 | codec 原样保留，覆盖写入前显示差异 |

段评字段的最终运行语义见 [JavaScript 书源](../reference/javascript-source.md) 和 [书源数据模型](../reference/source-schema.md)。表单的字段注释必须说明输入类型、空值含义、规则结果类型和所需宿主能力，不能只显示一个没有语义的字符串输入框。

字段覆盖必须以 [书源数据模型](../reference/source-schema.md) 为单一来源。表单元数据至少包含 `namespace`、`id`、输入类型、默认值、是否必需、空值含义、规则结果类型、所需 capability 和导入导出策略。当前没有编辑控件的字段使用 `preserve-only` 策略，编辑器显示其存在和原始值，保存时原样写回；未知字段也使用同样策略，不能因表单 schema 不认识而丢失。

## 编辑会话和数据流

编辑器处理带原文快照的会话，普通 JSON 对象不能承载完整编辑状态：

```ts
export interface PreviewResult {
  /** 预览使用的流程入口。 */
  action: 'explore' | 'search' | 'book-info' | 'toc' | 'content' | 'review'
  /** 脱敏后的请求和规则中间结果。 */
  trace: Array<{
    /** 当前步骤名称。 */
    stage: string
    /** 当前步骤的输入摘要。 */
    input: unknown
    /** 当前步骤的输出摘要。 */
    output: unknown
  }>
  /** 最终领域结果或结构化错误。 */
  output?: unknown
  /** 预览期间产生的诊断。 */
  diagnostics: EditorDiagnostic[]
  /** 预览结束时 scope、Cookie、变量和请求监听器是否已释放。 */
  resourcesReleased: boolean
}

export interface SourceEditorSession {
  /** 当前编辑会话身份，用于预览、保存和冲突判断。 */
  sessionId: string
  /** json 或 javascript 编辑模式。 */
  mode: 'json' | 'javascript'
  /** 用户当前编辑的原始文本。 */
  rawText: string
  /** 解析后用于表单和预览的规范化书源。 */
  source?: NormalizedSource
  /** 打开时的原文和版本快照。 */
  baseText: string
  /** 打开时的持久化版本，用于保存时的冲突比较。 */
  baseRevision?: string
  /** 当前字段、语法和能力诊断。 */
  diagnostics: Array<EditorDiagnostic>
  /** 是否存在尚未保存的修改。 */
  dirty: boolean
  /** 最近一次预览结果。 */
  preview?: PreviewResult
}

export interface EditorDiagnostic {
  /** 错误所在字段路径或脚本位置。 */
  path?: string
  /** 诊断阶段和稳定错误码。 */
  stage: 'parse' | 'schema' | 'rule' | 'capability' | 'preview' | 'conflict'
  /** 可供程序稳定判断的诊断编码。 */
  code: string
  /** warning 不阻止导出，error 阻止运行或保存，具体策略由会话动作决定。 */
  severity: 'info' | 'warning' | 'error'
  /** 面向编辑器用户的诊断说明。 */
  message: string
  /** 原文中的零基 UTF-16 偏移范围；编辑器自行转换为行列。 */
  position?: SourcePosition
}

export interface SourcePosition {
  /** 零基 UTF-16 起点，包含此位置。 */
  start: number
  /** 零基 UTF-16 终点，不包含此位置；start <= end。 */
  end: number
}
```

状态分成正交维度：load=closed/loading/ready，validity=valid/invalid，preview=idle/running/failed，save=idle/saving/conflict/failed。dirty 仅由 rawText 与 baseText 的差异决定，预览本身不改变 dirty。解析失败保留原文；保存比较 baseRevision，冲突由用户选择重载、覆盖或导出。切换、关闭和离开时检查 dirty，未经确认不丢弃修改。

导入、编辑、诊断、预览、保存和导出的数据流为：

```text
rawText
  -> import codec 保留 rawText/unknownFields/mainJs
  -> normalized source
  -> schema + rule diagnostics
  -> preview session 使用同一个 RuleContext
  -> 用户修改字段或脚本
  -> 重新诊断并标记 dirty
  -> 保存前再次校验和版本比较
  -> 用户确认后写入或导出
```

未编辑导出原文；编辑后保留规则对象/字符串形态、未知值及完整 mainJs，允许 JSON 空白和 key 顺序变化。不能承诺编辑后字节不变。保存输入包含编辑会话身份、baseRevision、候选原文和覆盖选择，返回新版本或结构化冲突；编辑会话 sessionId 与宿主认证会话不是同一个身份，不可用于授权。

编辑器保存不能直接调用数据库或把 Android API 当作核心依赖。它应把会话转换为 `SaveSourceInput`，由应用 service 重新读取当前用户快照、校验 `baseRevision`、计算规则与用户字段变化，再调用 `SourceRepository` 原子提交；规则变化后的检查失效和缓存清理遵循[书源持久化流程](../workflows/source-persistence-flow.md)。兼容 Android API 的保存由 adapter 单独映射，见[API 适配](../integration/legado-web-api-bridge.md)。

## 目标能力

### 结构化编辑

- 按 `BookSource` schema 编辑基础字段、发现分类和规则对象；
- 每个字段显示结果类型：元素列表、字符串、字符串列表、布尔值或 URL；
- 支持 JSON 书源和 JS 书源切换，但切换前保护未保存内容；
- 导入 JSON、远程 URL、文件 URI 和 JS 文本；
- 导出时保留原字段、未知字段和完整 `mainJs`。

### 规则诊断

编辑器调用核心词法解析器，提供：

- 模式识别结果；
- 规则链和组合符号树；
- 不平衡括号、非法 JSONPath、非法正则、未知选项和不支持宿主能力；
- 规则引用的变量、输入依赖和 URL 基准；
- 错误位置、字段路径、严重级别和修复建议。

诊断器可以比运行时更严格，但保存和运行必须明确区分“警告”和“会导致当前 Android 结果变化的错误”。

### 可复现预览

预览面板使用脱敏 HTML/JSON 输入和同一个 `RuleContext`：

```text
输入 body
  -> 规则模式和链条
  -> 每一步中间结果
  -> 替换/URL 归一化
  -> 最终字段值
```

发现分类、发现列表、搜索、详情、目录、正文各有预览入口；网络请求使用 fake/代理 host，由用户显式触发。分类预览要显示原始 `exploreUrl`、解析后的分类类型、选定 URL 和 `infoMap` 快照；请求预览要展示 URL、method、headers（脱敏）、body、最终响应 URL 和解析结果。

预览协议至少包含 `action`、书源候选、流程输入、脱敏响应、capability 集合和网络白名单。结果必须返回请求轨迹、每个规则步骤的输入输出、最终 DTO、诊断和资源清理状态；真实网络预览需要显式确认，每次预览创建独立请求上下文，不得复用保存页或其他用户的 Cookie、变量和 JS scope。

### 测试生成

用户可以把当前输入、字段规则和期望输出保存为 fixture。编辑器保存前运行静态诊断，CI 再运行 golden conformance；编辑器不能仅凭文本高亮宣称规则可用。

编辑器生成的 fixture 必须带稳定 `id`、脱敏输入、规则字段路径、期望输出、Android 证据、TypeScript 断言和 capability 要求，并交给 [一致性测试基线](../quality/conformance-tests.md) 校验。保存前诊断、预览结果和导出结果不能互相替代：静态诊断通过不代表网络流程或脚本运行成功。

## 组件边界

```text
source-editor UI
  -> source-schema form model
  -> rule tokenizer / diagnostics
  -> preview session
  -> import/export codec
  -> optional runtime host
```

表单配置可以继续采用 `namespace + id + type + hint`，但字段的类型、默认值、是否必需、规则结果类型和能力要求应来自 TypeScript schema。这样 UI、导入校验、运行时错误和测试 fixture 使用同一份定义。

编辑器组件只能调用 codec、诊断器和 preview host，不得在 UI 内复制 URL 展开、变量查找、规则解析或字段合并逻辑。保存和导出必须经过同一 codec；预览必须经过同一核心流程，保证编辑器显示的结果与 Node、SSR 运行结果来自同一套规则语义。

预览默认使用固定响应与临时 Cookie/缓存/变量空间。用户触发真实请求时展示目标及能力，不提交用户持久状态，不执行购买和段评写入；已发送的网络请求不因预览结束而撤回。预览结果带候选版本，编辑后迟到 trace 不覆盖新候选诊断。保存无效草稿与保存可运行源分开：草稿可导出，运行入口必须校验能力与字段，不通过高亮推断可执行。

## 安全和权限

- 编辑器默认只做静态解析；
- 运行 JS 预览必须在隔离服务或受限 worker 中执行；
- 网络预览需显示目标域名并使用白名单；
- Cookie、Token、密码和请求头在日志、fixture、分享链接中脱敏；
- 没有 WebView/Node 能力时显示“宿主不支持”，不能伪造空成功；
- 保存和导入覆盖操作保留原文候选，用户确认后才提交。

## 实施阶段

1. 先完成 schema form、导入导出和规则静态诊断；
2. 接入脱敏 fixture 预览，不执行任意脚本；
3. 接入 Node 沙箱 preview host；
4. 补保存、冲突、未保存保护、移动端和访问令牌测试；
5. 核心运行时稳定后再考虑独立 `@legado/source-editor` 包。
