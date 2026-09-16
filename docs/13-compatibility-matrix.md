# 兼容性矩阵

本矩阵同时记录目标承诺、Android 事实证据和 TypeScript 当前完成度。它是迁移验收清单，不是“已经兼容”的声明。当前仓库尚未实现 TypeScript runtime，因此所有尚未标记为已验证的 TS 项都不能被当作完成。

状态含义：

- `目标必须兼容`：第一版核心库的行为承诺。
- `声明存在时必须兼容`：书源声明该能力后，运行时必须保持其契约；没有声明时不强制启用。
- `目标可选能力`：由宿主能力标记决定，核心库需要可诊断地降级。
- `明确不支持`：第一版不实现，但导入、编辑器和运行时必须保留清晰错误。
- `目标设计`：上层产品能力，不是 Android 运行时兼容项。

| 能力 | 目标状态 | Android 证据 | TypeScript 当前状态 |
| --- | --- | --- | --- |
| 书源 JSON 对象和数组 | 目标必须兼容 | `BookSourceImport`、`BookSource.kt` | 未实现 runtime，待 fixture |
| `sourceUrls` 递归导入和远程来源限制 | 目标必须兼容 | `BookSourceImport`、导入流程 | 未实现 runtime，待 fixture |
| JS 源 `config` 和旧版 `source` | 目标必须兼容 | `JsSourceConfigTest` | 未实现 runtime，待 fixture |
| 默认旧式选择器 | 目标必须兼容 | `AnalyzeByJSoupDomTest`、`AnalyzeByJSoup` | 未实现 runtime，待 fixture |
| `@CSS:`、`@XPath:`、`@Json:` | 目标必须兼容 | `AnalyzeRule`、规则测试 | 未实现 runtime，待 fixture |
| CSS、XPath、JSONPath 规则链 | 目标必须兼容 | `AnalyzeRule`、解析器源码 | 未实现 runtime，待 fixture |
| `&&`、`||`、`%%` | 目标必须兼容 | `AnalyzeRule.splitRule`、规则测试 | 未实现 runtime，待 fixture |
| 索引、负索引、范围、负步长和排除 | 目标必须兼容 | `AnalyzeByJSoupDomTest`、`AnalyzeRule` | 未实现 runtime，待 fixture |
| `$n`、`##match##replace`、`@put/@get`、`{{}}` | 目标必须兼容 | `AnalyzeRule`、变量规则源码 | 未实现 runtime，待 fixture |
| 连续 `<js>` 和 `@js:` | 目标必须兼容 | `AnalyzeRule`、JS 规则测试 | 未实现 runtime，待 fixture |
| `@webjs:` | 目标可选能力 | `AnalyzeRule`、WebView 相关流程 | 未实现 runtime，需 capability 设计 |
| URL 页码、URL options、表单编码 | 目标必须兼容 | `AnalyzeUrl`、`AnalyzeUrlNetworkOptionsTest` | 未实现 runtime，待 fixture |
| Cookie、静态登录头和最终域名 | 目标必须兼容 | `AnalyzeUrl`、网络选项测试 | 未实现 runtime，待 fixture |
| `@js` 改写登录 URL 后的跨域登录头 | 目标必须兼容 | `AnalyzeUrl` 登录头判断源码 | 未实现 runtime，需 golden |
| 复杂登录 UI、验证码和多步骤登录 | 明确不支持 | `BookSource` 登录字段、WebView 流程 | 不纳入第一版 |
| 搜索、详情、目录、正文流程 | 目标必须兼容 | `WebBook`、四类流程测试 | 未实现 runtime，待 golden |
| 目录和正文分页、循环保护 | 目标必须兼容 | `BookChapterList`、`WebBook` | 未实现 runtime，待 fixture |
| 搜索精准匹配中的书名、作者和分类 | 目标必须兼容 | `SearchModel` | 未实现 runtime，待 fixture |
| 目录 `-` 前缀和 `reverseToc` 组合 | 目标必须兼容 | `BookChapterList` | 未实现 runtime，待 fixture |
| `canReName` 调用权限与非空配置判断 | 目标必须兼容 | `BookInfo` | 未实现 runtime，待 fixture |
| 卷节点空正文和非卷空正文回退 | 目标必须兼容 | `WebBook`、`JsSourceBookTest` | 未实现 runtime，待 fixture |
| JS 源返回值和字段归一化 | 目标必须兼容 | `JsSourceMarshallerTest`、`JsSourceEngineTest` | 未实现 runtime，待 fixture |
| `getContentBatch` 和 `contentBatch` | 声明存在时必须兼容 | `JsSourceConfig`、JS 源测试 | 未实现 runtime，待 fixture |
| 段评摘要、详情和回复 | 声明存在时必须兼容 | `JsSourceConfig`、`JsSourceReview` | 未实现 runtime，待 fixture |
| WebView 真实页面行为 | 目标可选能力 | WebView 相关流程 | 需 adapter 和 capability error |
| 编辑器预览与诊断 | 目标设计 | `modules/web` 配置和测试 | 仅规划，未实现独立编辑器 |

## 证据等级

表中的类名默认位于 `app/src/main/java/io/legado/app/`，测试名默认位于 `app/src/test/java/io/legado/app/` 或 `app/src/androidTest/java/io/legado/app/`。提交 fixture 时必须把简称替换为具体文件和测试用例，避免只写一个无法定位的类名。

Android 证据也需要分级：测试文件是可执行行为证据，流程源码是可追踪行为证据，单纯类型或字段声明只能证明数据存在，不能证明完整运行时语义。TS 项只有在独立 fixture、golden 输出和自动断言都存在时，才能从“待 fixture”改为“已验证”。

兼容性决策：当 TypeScript 解析器与 Jsoup、JsoupXpath、JsonPath 或 Rhino 结果不一致时，以 fixture 中固化的 Android 结果为准；若 Android 行为不稳定，先记录差异，再通过明确的版本能力标记处理，不能静默改变书源结果。
