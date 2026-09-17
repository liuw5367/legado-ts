# 规则语言与解析器

这是迁移的核心文档。规则字段都是字符串，但字符串不是单一语法：同一字段可能包含 HTML 选择器、XPath、JSONPath、正则、JavaScript、变量模板和替换表达式。TypeScript 实现必须先完成与当前行为一致的词法拆分，再调用相应解释器。

## 1. 规则执行上下文

`AnalyzeRule.setContent` 接收字符串、DOM 节点、JSON 对象或列表。当前实现的内容判断是：DOM `Node` 按 HTML 处理；其他值转文本后，若被判断为 JSON 则按 JSON 处理。设置新内容会清空 HTML、XPath、JSONPath 解析器缓存，但保留当前规则对象的变量和脚本缓存。

一个规则字段的执行上下文至少包含以下字段。`Book`、`BookChapter` 和规则对象以 [书源数据模型](source-schema.md) 为唯一字段来源，`RuleVariableView` 是规则执行接口，不能由每个流程各自实现一套：

```ts
export interface RuleContext {
  /** 当前请求或独立预览会话的稳定身份。 */
  requestId: string
  /** 当前规则输入，可以是 HTML 文本、DOM 节点、JSON 值或值列表。 */
  content: unknown
  /** 空 URL 的回退基准；详情、目录和正文流程分别传入当前阶段基准。 */
  baseUrl?: string
  /** 非空相对 URL 的解析基准，通常是最终响应 URL。 */
  redirectUrl?: string
  /** 当前书源，只读暴露给规则。 */
  readonly source: BookSource
  /** 当前书籍；搜索阶段可以为空。 */
  book?: Book
  /** 当前章节；搜索和详情阶段可以为空。 */
  chapter?: BookChapter
  /** 当前章节的下一章 URL，用于正文分页保护。 */
  nextChapterUrl?: string
  /** 当前调用可见的规则变量视图。 */
  variables: RuleVariableView
  /** 取消规则、请求和后续分页的信号。 */
  signal?: AbortSignal
}

export type VariableScope = 'local' | 'chapter' | 'book' | 'rule-data' | 'source'

export interface RuleVariableView {
  /** 按 Android 兼容优先级读取变量，不存在时返回 undefined。 */
  get(name: string): string | undefined
  /** 写入最具体的可用持久化层；local 变量只在当前 RuleContext 存活。 */
  set(name: string, value: string | null, scope?: VariableScope): void
  /** 只删除指定作用域中的变量，不能误删其他书籍或请求的变量。 */
  delete(name: string, scope?: VariableScope): void
  /** 判断指定查找优先级中是否存在非空变量。 */
  has(name: string): boolean
  /** 返回指定作用域的只读快照，供调试和脱敏 fixture 使用。 */
  snapshot(scope?: VariableScope): Readonly<Record<string, string>>
}
```

默认写入目标和读取顺序必须与 Android 一致：写入优先尝试当前章节、当前书籍、当前规则数据，最后写入书源变量；读取先查 `local`，再查章节变量、书变量、规则数据变量和书源变量。读取结果为空字符串时继续查找下一层，全部没有结果时返回空字符串给 `@get` 和 `{{}}`。`bookName` 和 `title` 是保留名称，分别映射当前书名和章节标题。`set` 使用 `null` 表示删除，`snapshot` 不得包含 Cookie、Token、密码或 Authorization。

变量作用域由流程创建：搜索至少创建 `rule-data` 和 `source`，详情、目录和正文额外创建 `book`，章节规则额外创建 `chapter`，每次规则调用创建新的 `local`。书源变量是跨调用、按书源身份保存的持久化数据；书籍和章节变量随对应对象保存；`rule-data` 和 `local` 在本次流程或规则实例结束后释放。SSR 必须为每个请求创建独立的变量视图，不能把 `VariableStore` 放在模块级单例中。

`content` 的类型由当前阶段决定，可以是 HTML 字符串、DOM 节点、JSON 对象或列表。`baseUrl` 用于空 URL 回退，`redirectUrl` 用于非空相对 URL 归一化；二者不能在流程适配器中混为一个字段。

规则引擎使用的 `RuleVariableView` 是执行层视图；宿主的 `VariableStore` 负责持久化、作用域关闭和等待在途写入，二者通过宿主 adapter 连接。这样规则语义中的 `set/delete/has/snapshot` 不会与宿主接口的 `put/close` 产生同名冲突。

## 1.1 一次规则求值的完整结算

一次求值必须按以下阶段结算，调用方不需要通过 Android 类名补全顺序：

1. 固定 `requestId`、`operationId`、`sourceRevision`、`baseUrl`、`redirectUrl`、预算和 `AbortSignal`，创建本次规则的 `RuleVariableView`。
2. 根据输入值判断 HTML/DOM、JSON、普通文本或列表；保留 `null`、`undefined`、空字符串、空数组、空对象和合法节点集合的差异。
3. 先扫描 JS/WebJS 块，再识别前缀和默认模式；按括号、方括号、字符串和插值边界拆分 `&&`、`||`、`%%`。
4. 按模式执行选择器、XPath、JSONPath、Regex、Js 或 WebJs；每一步输出中间值、诊断和下一步输入，不把对象或节点提前转成字符串。
5. 按规则顺序应用索引/范围/排除、变量读写、插值、字段正则和 `##` 替换，再按 `getElement`、`getElements`、`getString`、`getStringList` 或 `getObject` 归一化。
6. 返回结果、诊断、变量变更和能力/资源状态；流程结束时关闭变量视图并等待脚本、解析器和请求资源释放。

| 情况 | 规则层结果 | 流程层终态 |
| --- | --- | --- |
| 合法匹配或合法转换 | 节点、标量、对象或列表 | `success` |
| 合法无匹配、空字段或空列表 | 空值或空列表，并保留阶段 | `empty`；若字段允许继续则可继续后续流程 |
| 单字段 JSONPath/选择器/正则错误 | 诊断，按字段策略返回空值或跳过 | 可继续时保留诊断，否则 `failed` |
| 必需规则失败、脚本异常或请求失败 | 稳定错误码、阶段和字段 | `failed` |
| 宿主没有所需 JS/WebView/浏览器能力 | 不执行替代路径 | `capability-missing` |
| signal、预算或资源释放请求 | 停止新步骤，等待已启动资源收尾 | `cancelled`；若版本已变化则 `stale` |

`null` 表示规则明确产生空值，`undefined` 表示没有该字段或能力没有返回值；流程是否把它们归一化为空字符串由输出 API 决定。规则诊断必须说明 `canContinue`，但不能把取消或预算耗尽包装成普通字段错误。

## 2. 模式识别

当前模式名称是 `XPath`、`Json`、`Default`、`Js`、`Regex`、`WebJs`。

| 写法 | 模式 | 处理方式 |
| --- | --- | --- |
| `@@...` 或无标记普通规则 | Default | Jsoup 兼容选择器和旧式 `tag.xxx` 链 |
| `@CSS:...` | Default | 强制将内容作为 CSS 规则处理 |
| `@XPath:...` 或以 `/` 开始 | XPath | XPath 节点/文本结果 |
| `@Json:...`、`$.foo`、`$[0]` 或 JSON 内容中的普通路径 | Json | JsonPath 及嵌套 JSON 规则 |
| `:正则` | Regex | 仅在 `getElement`/列表目录类场景作为全规则正则 |
| `<js>...</js>`、`@js:...` | Js | Rhino JavaScript 片段 |
| `@webjs:...` | WebJs | 在后台 WebView/浏览器上下文中执行 |

`@@` 会去掉前缀。`@XPath:` 和 `@Json:` 会去掉前缀。`@CSS:` 由 HTML 解析器识别并去掉前缀。以 `$.` 或 `$[` 开头的规则即使省略 `@Json:` 也会进入 JSON 模式。以 `/` 开头的 XPath 不要求写 `@XPath:`。

`@CSS:`、`@XPath:` 和 `@Json:` 的前缀匹配不区分大小写，例如 `@css:`、`@xPaTh:` 和 `@JSON:` 分别进入相同模式。前缀后的规则正文仍按对应模式原样解析，不能因为前缀大小写被改写就改变选择器或路径内容。

`:` 只有在 `splitSourceRule(..., allInOne = true)` 的入口且位于规则首字符时才强制 Regex；这也是它与 CSS 伪类冒号冲突的原因。迁移时不能把任意包含冒号的规则都判断成正则。

## 3. 规则块和规则链

### JavaScript 块

`<js>...</js>` 和 `@js:...` 会成为 `Mode.Js` 规则块；`@webjs:...` 成为 `Mode.WebJs` 规则块。普通文本和脚本块可以组合，脚本块的结果成为后续链条的输入。

**兼容要求**：splitSourceRule 先扫描全部 JS，再扫描 WebJS，并共享 start 游标。兼容路径按此顺序复现，不改成统一按源文本排序。混合标记 golden 尚未执行；更合理的扫描顺序属于另一语义版本。

### `&&`、`||`、`%%`

当前解析器只显式避开方括号和圆括号平衡组。平衡组内部会识别引号和转义，因此 JSONPath 内部的 `&&`/`||`、CSS 属性选择器不会被切断；但不能把它概括为全局保护所有引号。TypeScript 实现必须分别记录普通规则、代码规则和 `{{...}}` 内嵌表达式的边界。

- `&&`：依次执行各分支并拼接非空结果；
- `||`：按顺序尝试分支，第一个有结果的分支成功后停止；
- `%%`：按索引交错合并多个结果，取第一分支长度作为主长度，其他分支缺项时跳过。

对字符串结果，多个值通常使用换行连接；对列表结果，先保持列表形态，最后才由 `getString` 或 `getStringList` 做转换。

## 4. Default/Jsoup 规则

### 选择和链式访问

默认解析器兼容两类写法：

- CSS 元素选择：`@CSS:div.book`，主要用于 `getElements`；
- 旧式选择：`class.book`、`tag.a`、`id.main`、`text.关键词`，以及普通 CSS 选择器。

使用 `@` 连接节点级规则，例如 `class.list@tag.a@href`。链条前部选择元素，最后一段决定输出：

| 尾段 | 输出 |
| --- | --- |
| `text` | 每个节点的全部文本，去除空结果 |
| `textNodes` | 直接文本节点，不包含后代元素文本；同一节点的多段文本以换行连接 |
| `ownText` | 节点自身文本 |
| `html` | 选中节点 HTML，并移除 `script`/`style` |
| `all` | 选中节点的完整外部 HTML |
| 其他字符串 | 作为属性名读取，空属性丢弃；URL 列表还会去重 |

`@CSS:` 的最后一个 `@` 分隔选择器与输出属性。用于 `getString/getStringList` 时应写成 `@CSS:div.book@text`、`@CSS:a@href` 等完整形式；纯 `@CSS:div.book` 是元素列表选择，不应当当作字符串字段示例。非 CSS 链则逐级选择节点。解析不能通过删除原 DOM 节点实现排除，因为同一文档会被多个字段重复读取；当前测试要求排除索引后原 DOM 仍可读取。

### 索引、范围和排除

旧式索引示例：`tag.a.0`、`tag.a.-1`、`tag.a.0:3`、`tag.a!0:2`。点号表示选择，感叹号表示排除，负索引从列表末尾计数。

方括号写法示例：`tag.a[-1,0]`、`tag.a[!0,-1]`、`tag.a[3:-2:-10]`。范围格式是 `start:end[:step]`，两端和步长可以是负数；省略起点默认 0，省略终点默认末项。越界的单项索引丢弃；范围两端会被裁剪到有效区间；空结果返回空列表。`tag.a[-1:0]` 可用于反向选择。

索引集合去重，但输出顺序按规则提供的选择顺序保持。排除只过滤本次结果列表，不修改源 DOM。

## 5. XPath 规则

XPath 返回节点列表，再由 `getString` 以换行连接 `asString()` 结果；`getStringList` 保留列表。该等价关系依赖 JsoupXpath 内部实现，迁移中待验证。XPath 与 `&&`、`||`、`%%` 的组合规则和 Default 模式一致。

HTML/XML 解析必须保持当前差异：XML 声明开头使用 XML parser；普通文本使用 HTML parser；以 `</td>`、`</tr>` 或 `</tbody>` 结尾的片段会补最小表格容器后再做 XPath。旧版 jsoup 书源依赖 HTML 自闭合标签直接闭合（如 `<a/>`），当前解析器会把新 HTML 标签设为自闭合，CSS 与 XPath 共用该 DOM，迁移时不得改变 textNodes 语义。

## 6. JSONPath 规则

JSONPath 规则支持标量、对象、数组和嵌套插值：

```text
$.content.items
@Json:$.book.title
prefix-{$.author}-suffix
```

`{$.rule}` 先递归执行内部 JSONPath 并替换文本；如果没有成功插值，再把整个字符串当成 JSONPath 读取。`getString` 对数组使用换行连接；`getStringList` 对数组逐项转文本；`getObject` 保留对象；`getList` 要求列表结果。

JSONPath 解析失败时当前实现记录错误并返回空/空列表，不能把单个字段解析失败扩大为整个书源流程失败，除非上层字段明确要求该值存在。

## 7. Regex 规则和 `$n`

两种正则语义必须分开：

1. `:regex` 全规则模式：`AnalyzeByRegex.getElements` 为每次匹配返回一个列表，列表第 0 项是完整匹配文本，后续依次是捕获组；不存在的捕获组以空字符串占位。`getElement` 返回首个匹配的同样结构，并可用多个正则串联。串联时，后一个正则作用于前一个正则产生的完整匹配文本集合，不作用于前一个正则的各个捕获组。该语法主要给书籍列表和目录列表使用。
2. 字段规则中的 `$1`、`$2`：当字段最终被识别为 Regex 时，先执行其它片段得到捕获组列表，再用 `$n` 取组。组不存在时保留原 `$n` 文本。

## 8. 内嵌变量、JS 和替换

### `@put`

`@put:{"key":"rule"}` 会从规则文本删除，并在当前规则步骤前执行。每个 value 本身还是一条规则，执行结果写入变量。JSON 先尝试严格解析，失败时允许历史宽松解析并记录提示。

### `@get` 和 `{{...}}`

- `@get:{key}` 读取变量并插入文本；
- `{{expression}}` 若以 `@`、`$.`、`$[` 或 `//` 开头，视为规则递归执行；否则视为 JS；
- JS 结果中的整数 Double 要以无小数位文本输出，其他结果使用字符串化；`null` 不插入文本。

变量查找优先级是：当前规则局部变量、章节变量、书变量、通用规则数据变量、书源变量；`bookName` 和 `title` 是保留含义，分别优先映射书名和章节标题。`@put` 写入后，后续规则步骤和同一流程可以读取；流程结束后的持久化结果由宿主提交，规则引擎不能自行开启数据库事务。

### `##match##replace`

字段结果支持在末尾附加正则替换：`规则##匹配##替换`。第三段可以省略，`规则##匹配` 等价于使用空字符串替换，即删除匹配内容；第四段只要存在就只替换首个匹配。替换发生在当前规则步骤结果生成之后；正文的 `replaceRegex` 则是在多页正文合并后再次执行。

当前实现编译正则失败时对全量替换回退为字面字符串替换；迁移必须以测试固定这一历史行为，不应直接依赖 JavaScript `String.replace` 的差异语义。

## 9. 输出 API 语义

| API | 空规则 | 空结果 | 其他行为 |
| --- | --- | --- | --- |
| `getString` | `""` | `""` | 默认 HTML unescape；URL 模式转绝对 URL |
| `getStringList` | `null` | `null` 或空列表，依输入类型 | 字符串按换行拆分；URL 去重并转绝对 URL |
| `getElement` | `null` | `null` | 可返回节点、对象或脚本结果 |
| `getElements` | 空列表 | 空列表 | 清理 null、NOT_FOUND、数组包装结果 |

URL 模式中，空字符串回退 `baseUrl`；非空字符串相对 `redirectUrl` 转绝对 URL。`getStringList(isUrl = true)` 丢弃空 URL 并去重。

当输入内容为 NativeObject（原生段评对象）时，`getStringList` 只使用第一条规则：先执行其 `@put` 映射；`Mode.Js` 时以该对象为 `result` 执行脚本；`Mode.Json` 时对对象执行 JSONPath 读取列表；规则带多个参数时返回规则文本用于 `{{}}` 插值；否则把规则文本作为键直接访问对象属性。

## 10. JS 绑定和错误边界

规则 JS 当前可见绑定包括：`java`、`cookie`、`cache`、`source`、`book`、`result`、`baseUrl`、`chapter`、`chapters`、`title`、`src`、`nextChapterUrl`、`rssArticle`、`fromBookInfo`，以及批量场景的 `paraIndex`、`paraData`、`page`。

`java` 绑定含 `openUrl`、`openVideoPlayer`、`startBrowser` 等 UI 跳转方法。宿主启用 `blockSourceNavigation` 且当前协程上下文携带 `SuppressSourceNavigation`（换源、批量检测等后台流程）时，这些跳转和 WebView 弹窗会被阻止；Android 当前行为是静默 `return`，JS 仅得到 `undefined`（`JsExtensions.kt` L1251/L390/L405），`policy-denied` 诊断是迁移设计，映射示例见 [运行时统一契约](runtime-contracts.md)。TypeScript 宿主应输出空结果或显式的策略拒绝，不能弹出书源网页或视频。

脚本异常向上抛出；JSONPath 读取异常通常转为空值并记录；不平衡的规则括号会抛出解析错误；取消必须原样传播，不能被普通异常兜底吞掉。`@webjs` 必须在后台宿主执行，核心库没有浏览器时应返回明确的能力缺失错误。

## 11. 迁移验收重点

实现顺序应是：平衡切分器 -> 模式识别 -> Default 元素选择 -> XPath/JSONPath -> Regex -> 变量/插值 -> 替换 -> 输出归一化。每完成一层都用固定 fixture 对比 Android 结果。不能先选择 TypeScript 生态中最方便的 CSS/JSONPath 库，再假设其语义天然一致。

## 12. 跨语言差异与诊断

| 语义 | 实现要求 | 差异样本 |
| --- | --- | --- |
| 切分 | 复现 RuleAnalyzer 的规则/代码平衡分支，不全局保护所有引号 | CSS 属性内与顶层引号内的 `\|\|` 分开验证 |
| 正则 | 适配 Java Pattern 的语法、flag、捕获与替换 | `$1`、反斜杠、零宽匹配、非法模式回退 |
| 字符 | 编辑位置为 UTF-16；字符变换按原 API 的 code point 行为 | emoji 与代理对 |
| 数值空值 | 整数 Double、null/undefined、空数组分别转换 | `1.0`、null 插值、空变量继续查找 |
| DOM | 保持容错、文本拼接、实体及节点身份 | 表格片段、畸形 HTML、textNodes、重复读取 |
| XPath/JSONPath | 实际方言与返回类型在输出 API 处归一化 | 标量、对象、空选择、非法路径、嵌套插值 |

诊断器可以提示可疑规则，但不改变执行结果。原入口把非法 JSONPath 转为空值时，静态诊断不能擅自禁止整源保存。中间表示记录 mode、原文、位置与替换信息；编译缓存不得携带上次 DOM、变量值或 JS scope。
