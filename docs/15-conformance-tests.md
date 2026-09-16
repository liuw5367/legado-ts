# 一致性测试基线

## 当前已有证据

仓库中与书源运行时直接相关的测试包括：

- `app/src/test/java/io/legado/app/model/analyzeRule/AnalyzeByJSoupDomTest.kt`：自闭合链接、`textNodes`、链式选择、节点身份、正向/负向/排除索引和 DOM 非破坏性；
- `app/src/test/java/io/legado/app/model/analyzeRule/AnalyzeRuleElementsNormalizationTest.kt`：JS 数组结果过滤 null；
- `app/src/test/java/io/legado/app/model/analyzeRule/AnalyzeUrlNetworkOptionsTest.kt`：Cookie 域、timeout、布尔选项、DNS 字面量、代理冲突、重定向和客户端超时；
- `app/src/androidTest/java/io/legado/app/model/webBook/SourceContentCompatibilityTest.kt`：正文 textNodes/替换、Base64 JS 内容和目录刷新顺序；
- `app/src/test/java/io/legado/app/model/webBook/SearchPaginationContractTest.kt`：搜索 page owner、回调时序和取消；
- `app/src/test/java/io/legado/app/model/jsSource/JsSourceConfigTest.kt`：配置抽取、必备函数、文件源、批量、发现、登录和脚本剥离；
- `app/src/test/java/io/legado/app/model/jsSource/JsSourceMarshallerTest.kt`：搜索/详情/章节返回值归一化；
- `app/src/test/java/io/legado/app/model/jsSource/JsSourceEngineTest.kt`：scope 绑定、脚本返回值、toJSON/getter、undefined 和取消；
- `app/src/test/java/io/legado/app/model/jsSource/JsSourceBookTest.kt`、`WebBookTest.kt`：卷节点、空正文和文件源；
- `modules/web/tests/sourceEditor.test.js`：现有 Web 编辑器的响应式布局、脚本模板、状态恢复、保存和访问令牌行为。

当前没有与这些 Kotlin 规则结果直接对照的 TypeScript runtime 测试；需要新增独立 fixture 和 golden 输出。

当前仓库中的 `examples/rule-fixtures.json`、`examples/source-minimal.json` 和 `examples/source-js-minimal.js` 是脱敏的文档样例，不等同于 Android golden。它们可以作为 fixture 模板，但在补齐 Android 实际输出和 TypeScript 断言前，不能用于宣称兼容。

## Fixture 格式

建议每个 fixture 记录：

```json
{
  "id": "rule-default-text-nodes-001",
  "status": "ts-pending",
  "source": "https://fixture.invalid/source",
  "input": { "kind": "html", "body": "..." },
  "context": { "baseUrl": "https://fixture.invalid/book/" },
  "operation": { "kind": "string", "rule": "div@textNodes" },
  "expected": { "value": "..." },
  "androidEvidence": {
    "kind": "test",
    "path": "app/src/test/java/io/legado/app/model/analyzeRule/AnalyzeByJSoupDomTest.kt",
    "case": "待补充确切测试用例"
  },
  "tsAssertion": "待实现"
}
```

字段约定：`id` 是稳定且不可复用的用例标识；`status` 使用 `android-verified`、`android-source-only`、`ts-pending` 或 `verified`；`source` 是脱敏后的书源身份；`input` 是解析器或流程输入；`context` 是显式注入的运行上下文；`operation` 描述调用类型和原始规则；`expected` 是稳定输出；`androidEvidence` 指向事实来源；`tsAssertion` 指向 TypeScript 测试或记录待办。真实 fixture 不得写入 Cookie、Token、密码或账号。

golden 中只保存稳定输出。错误 fixture 还要保存 `stage`、错误类别、是否允许流程继续和能力标记，不比较平台特有的堆栈文本。网络流程应保存请求描述和脱敏响应，不直接依赖真实站点。

## 必须覆盖的规则样本

### 解析器

- 默认选择、`@CSS:`、`@XPath:`、`@Json:` 和自动 JSON 识别；
- `&&` 拼接、`||` 首个成功、`%%` 按索引交错；
- 选择器和 JSONPath 中含 `&&`/`||` 的平衡切分；
- `@` 链、`text`、`textNodes`、`ownText`、`html`、`all` 和属性；
- 正索引、负索引、范围、负步长、排除和越界；
- `:regex`、`$1`、`##match##replace`、首个替换；
- `@put`、`@get`、规则型/JS 型 `{{}}`、多个变量和变量优先级；
- 空规则、空列表、字段缺失、null、非法 JSON、非法正则和不平衡括号；
- 连续 `<js>`/`@js:`/`@webjs:` 混合块的顺序。
- 纯 CSS 元素选择与 CSS 字符串输出的边界：`@CSS:div.book` 可用于元素选择，字符串读取需要 `@text`、`@href` 等终端输出。

### URL

- 相对 URL、query、已编码参数、UTF-8/escape、POST 表单/JSON/XML；
- `<...>` 页码替换、`{{}}` 与 URL `@js` 顺序；
- options 的 method/header/body/type/charset/retry/webView/bodyJs/timeout/followRedirects；
- Cookie 合并优先级、最终域名、跨域登录头；
- 非法 timeout、布尔值、DNS、proxy + dnsIp、数据 URL、302。
- `origin` 字段的导入导出保留，以及当前请求实现不使用该字段的事实。

### 流程

- 搜索列表、详情页回退、去重、精准合并和取消；
- 详情 `init`、字段覆盖、简介特殊标记、目录缓存和文件下载 URL；
- 目录分页、重复 URL、重复章节、卷节点、VIP/购买、formatJs 和顺序；
- 正文分页、下一章保护、HTML 清洗、副文、标题图片、空正文、缓存和批量兜底。
- 卷节点空正文、非卷章节空正文回退、目录 `-` 前缀与 `reverseToc` 组合、`canReName` 非空配置和调用权限。
- 精准搜索按书名、作者和分类命中，且分类命中进入分类结果组。
- 段评摘要、详情、回复的函数配对、段落索引和分页返回值。

## 验证层级

1. 规则纯函数测试：词法拆分、模式和组合；
2. parser adapter 测试：同一 DOM/JSON 的输出；
3. 流程组合测试：用 fake HTTP 保留完整请求和解析链；
4. Node/Next adapter 测试：真实 fetch 入口、AbortSignal、Cookie 隔离和响应限制；
5. 编辑器测试：诊断、预览、未保存修改、导入导出和移动端布局。

测试资源必须在每个用例结束时释放。网络真实站点只用于人工诊断，不作为稳定 golden 来源。任何兼容性结论都要同时注明 Android 证据和 TypeScript 断言，不能只依赖文档示例或人工截图。
