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

段评字段的最终运行语义见 [JavaScript 书源](10-javascript-source.md) 和 [书源数据模型](02-source-schema.md)。表单的字段注释必须说明输入类型、空值含义、规则结果类型和所需宿主能力，不能只显示一个没有语义的字符串输入框。

## 目标能力

### 结构化编辑

- 按 `BookSource` schema 编辑基础字段和规则对象；
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

搜索、详情、目录、正文各有预览入口；网络请求使用 fake/代理 host，由用户显式触发。预览结果要展示请求 URL、method、headers（脱敏）、body、最终响应 URL和解析结果。

### 测试生成

用户可以把当前输入、字段规则和期望输出保存为 fixture。编辑器保存前运行静态诊断，CI 再运行 golden conformance；编辑器不能仅凭文本高亮宣称规则可用。

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
