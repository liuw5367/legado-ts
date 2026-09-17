# 发现流程与分类规则

发现入口由书源的 `exploreUrl` 定义。它有两个阶段：先把入口文本解释为可选分类，再由调用方选定分类 URL，调用书源获取书籍列表。发现列表与搜索列表复用字段解析，但入口、上下文和是否参与流程的条件不同。

## 分类入口

Android 的 `BookSource.exploreKinds()` 在 `exploreUrl` 为空时返回空列表。非空内容有三种形态：

| 输入形态 | 处理结果 |
| --- | --- |
| JSON 数组 | 解析为 `ExploreKind[]`，每项保留 `title`、`url`、`type`、`action`、`chars`、`default`、`viewName`、`style` |
| 普通文本 | 按 `&&` 或换行分项，再按 `::` 分出标题和 URL；没有 URL 的项仍可解析，但不能直接请求列表 |
| `@js:` 或 `<js>...</js>` | 执行脚本得到文本，再按 JSON 数组或普通文本解释；脚本可以访问本书源的 `infoMap` |

以上是 `app/src/main/java/io/legado/app/help/source/BookSourceExtensions.kt` 的现状。TypeScript 目标应把分类解释放在书源 package 中，返回分类结果与诊断；脚本执行和分类结果缓存通过宿主能力提供。Android 的缓存键由书源 URL 与 `exploreUrl` 组成，分类文本改变时会重新计算。移植时还要考虑用户会话或 `infoMap` 对脚本结果的影响，不能把依赖用户状态的分类结果跨用户共享。

JSON 分类中的 `type: url` 可以提供可请求的 URL。`text`、`button`、`toggle`、`select` 及 `action`、`viewName` 是现有 Android 发现界面的交互协议。package 负责解析、保留和报告所需能力；应用适配器负责显示控件和执行用户动作。这些交互能力属于完整移植清单，若某个宿主尚未实现，应返回明确诊断，不能把它解释成普通 URL。`exploreScreen` 在当前实体中存在，但本次核对的发现请求链没有读取它；导入和导出保留该字段，执行语义待源码与样本进一步验证。

## 获取发现列表

应用先筛选启用发现的书源，读取分类，选择一个可请求的分类 URL，再调用单书源发现入口。`enabledExplore` 是应用选择书源的条件，不应在已显式传入书源的解析函数中偷偷改变结果。

```text
BookSource + 用户会话
  -> 解释 exploreUrl，得到分类和诊断
  -> 应用选择分类、收集筛选输入
  -> 生成选定的发现 URL 与 infoMap 快照
  -> 创建独立请求上下文
  -> JS 源：调用 explore(url, page)，归一化 SearchBook[]
  -> 声明式源：展开 URL、请求、登录检测、重定向检查
  -> 按 ruleExplore 解析列表；bookList 为空时使用 ruleSearch
  -> 去重、返回 SearchBook[] 与诊断
  -> 释放本次请求的脚本、变量和监听器
```

声明式入口见 `app/src/main/java/io/legado/app/model/webBook/WebBook.kt` 的 `exploreBookAwait`。它接受调用方已经选定的 `url` 和从 1 开始的 `page`，并把书源级 `infoMap` 传给 `AnalyzeUrl`。最终响应 URL 是规则解析和相对地址的基准。`BookList.analyzeBookList` 在发现时先检查 JSON 分类格式以供调试，再选择 `ruleExplore`；仅当 `ruleExplore.bookList` 为空时退回 `ruleSearch`。列表项字段、空书名丢弃、同源去重与详情页回退沿用 [搜索流程](search-flow.md) 的 `BookList` 行为。JS 源调用 `explore(url, page)`，返回值按搜索结果数组归一化。

分类列表与发现结果列表是不同输出：前者回答“有哪些入口和控件”，后者回答“选定入口这一页有哪些书”。单个分类请求失败不得删掉其他分类；换分类或换页时，调用方应取消旧请求并按分类身份和页码隔离结果。分类缓存更新不能复用旧 URL 对应的结果。正文、目录和详情仍以选中书籍的身份进入各自流程。

## 错误与验证

- `exploreUrl` 为空：分类结果为空，不发起网络请求。
- 分类 JSON 非法：Android 捕获异常后返回标题以 `ERROR:` 开头的分类项，并把错误堆栈放在该项 URL 中。TypeScript 目标应保留可显示的错误项或等价诊断，原文供编辑器修复；对外响应不得泄露原始堆栈，也不能伪造成空书籍列表。
- 分类脚本失败或宿主没有脚本能力：返回脚本或能力错误；其他普通分类仍可使用。
- 分类 URL 为空：保留该分类元数据，但拒绝直接获取列表。
- 发现响应失败、列表规则失败或取消：沿用单书源列表流程的错误和清理约定，不能覆写较新分类的结果。

至少用静态 JSON、普通文本、动态 JS、`infoMap`、`ruleExplore` 到 `ruleSearch` 回退、JS 源 `explore`、分类切换取消和用户会话隔离建立 fixture。`type` 为非 URL 的控件需分别证明原样保留与能力诊断。用例归属见 [一致性测试基线](../quality/conformance-tests.md)。

Web 分类身份由源版本、分类位置及当前 infoMap 快照共同界定，不仅用显示 title。控件更新先产生新的 infoMap 再发起列表 operation；旧 operation 迟到结果只清理，不覆盖新分类。动态分类整个脚本失败时不虚构“其他分类仍可用”，只能保留上一次成功结果并明确 stale，或显示错误。分类与书籍结果分别缓存，未配置 exploreUrl 返回空分类且零网络请求。
