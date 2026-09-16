# URL 与请求规则

## 1. 展开顺序

当前 `AnalyzeUrl.initUrl` 的顺序是：

1. 执行 URL 中的 `<js>...</js>` 或 `@js:` 片段；片段之间的普通文本通过 `@result` 串接；
2. 展开所有 `{{js}}`，结果为空时使用空字符串；整数数字按无小数位文本输出；
3. 展开页码占位符 `<...>`：第 1 页使用第一个逗号项，超出配置项数量后使用最后一个；
4. 用“逗号后紧跟 `{`”识别 URL 选项 JSON，首个逗号前是基础 URL；
5. 以 `baseUrl` 解析相对 URL，并用解析后的 URL 更新请求基准；
6. 应用请求选项和选项中的 `js`；
7. GET/HEAD 拆分 query，POST 根据内容类型拆分或保留 body；
8. 由 HTTP 或 WebView 适配器发起请求。

内嵌 JS 必须先于页码占位符处理，因为 JS 内容可能包含 `<`/`>`。迁移时不能先按尖括号切分整条 URL。

## 2. URL 选项

示例：

```text
https://example.com/search,{
  "method":"POST",
  "headers":{"Content-Type":"application/x-www-form-urlencoded"},
  "body":"keyword={{key}}",
  "timeout":5000,
  "followRedirects":false
}
```

| 字段 | 当前语义 |
| --- | --- |
| `method` | `POST`、`HEAD` 明确支持；其他值回退 GET |
| `headers` | 合并到请求头；帮助文档要求 key 大小写按原文保留 |
| `body` | 字符串、JSON 对象或 JSON 数组最终转为请求体 |
| `origin` | UrlOption 中仍可出现的历史字段；当前 AnalyzeUrl 不使用它，导入导出应保留原值 |
| `type` | 二进制/媒体类型提示；非字符串响应路径使用 |
| `charset` | 参数编码字符集；`escape` 使用 URL escape |
| `retry` | 请求重试次数，未配置为 0 |
| `webView` | 非空且不为 `false`/`"false"` 时启用 WebView |
| `webJs` | WebView 页面加载后执行的脚本 |
| `bodyJs` | 普通 HTTP 响应返回后处理 body 的脚本 |
| `timeout` | 有效正整数毫秒；无效值忽略 |
| `followRedirects` | 支持布尔、`0/1`、`false/true` 字符串；其他值忽略 |
| `dnsIp` | 当前目标域名使用的 IPv4/IPv6 字面量列表；`resolveIp` 是旧别名 |
| `js` | URL 选项解析后执行，结果写回 URL |
| `serverID` | 服务端路由/节点提示 |
| `webViewDelayTime` | WebView 加载后的非负等待毫秒数 |

宽松 JSON 仅用于历史兼容，并应记录警告。严格 JSON 优先。

`proxy` 不是 `UrlOption` 的独立字段。当前 Android 路径从已合并的请求头中读取特殊的 `proxy` 值并移出普通 Header；TypeScript Host 应把这条兼容行为单独记录，不能把它误当成普通远端请求头。`headers` 的键名要原样保留，因为当前 `Content-Type` 判断存在大小写敏感路径。

## 3. 参数编码

GET/HEAD：

- URL query 单独拆出，保留已编码的 query；
- 未编码参数按当前查询编码器处理；
- `urlNoQuery` 是不带 query 的请求 URL。

POST：

- body 是 JSON 或 XML，或显式提供 `Content-Type` 时不按表单拆分；
- 其他 body 按 `key=value&...` 解析并进行表单编码；
- 空值字段和无等号字段要保留当前分隔语义；
- `charset` 未提供时使用 UTF-8，`escape` 使用 escape 模式。

## 4. 响应和执行路径

普通 HTTP 请求可以在响应后执行 `bodyJs`，脚本结果成为新的 body。XML 响应若 Content-Type 表明 XML 但 body 缺 XML 声明，当前实现会补声明，确保后续 XML/XPath 解析可用。

WebView 请求使用 `webJs` 或调用方传入的 JS，并可以传入 `sourceRegex` 做资源嗅探。普通 HTTP 的 timeout、重定向和 DNS 选项不能假定继续控制 WebView 内部导航；这属于宿主能力差异。

`type` 非空时走字节响应，当前 Android 路径返回十六进制字符串给 `StrResponse`。TypeScript 应在响应类型中区分 `text`、`bytes` 和媒体 URL，不能把二进制误解码成 UTF-8。

## 5. Cookie、登录头和重定向

请求前把 CookieStore 中对应域的 Cookie 与 URL 选项中的 `Cookie` 合并，临时 URL 选项优先；启用 CookieJar 时保存响应中的 Set-Cookie。当前 Cookie 域按解析后的目标 URL 计算，封面 CDN 不应错误使用书源站点 Cookie。

登录头默认只发往书源同站二级域名；需要跨域时由 URL 选项显式提供。注意，当前保护逻辑依据初始 URL 判断，URL 中的 `@js` 如果把地址改写到跨域目标，不能假设登录头一定会被重新拦截。TypeScript 迁移应将这一点作为兼容事实和安全告警分别记录。复杂登录 UI 不在第一版核心范围内，但静态 Header、Cookie、Token 和 loginCheckJs 的宿主端口必须保留。

`followRedirects=false` 时，普通请求返回 3xx，不进入 WebView；开启时使用最终 URL 作为 redirectUrl。书源流程使用最终 URL解析相对资源，同时保留初始 URL用于去重和分页循环判断。

## 6. DNS、代理和超时边界

- `dnsIp` 只能包含 IPv4/IPv6 字面量，可用逗号分隔；域名、非法八位组和带 zone 的地址拒绝；
- `dnsIp` 与 `proxy` 同时配置直接报错，不能静默直连；
- `timeout` 必须是有效正整数并受 HTTP 客户端上限约束；
- 未显式配置时沿用宿主默认 timeout、重试和重定向策略；
- AbortSignal 取消必须立即传播到 HTTP、解析器和脚本运行时。

这些边界已有 `AnalyzeUrlNetworkOptionsTest` 覆盖，包括 timeout、布尔解析、DNS 字面量、目标域名范围、代理冲突、重定向和派生 call timeout。TypeScript 应保留同等断言。

## 7. 浏览器和 SSR 约束

浏览器不能默认跨域访问所有书源，SPA 需要 Node/Next.js 代理或站点 CORS。Next.js 服务端代理不得复用跨请求 CookieStore、JS scope 或变量 map。HTTP 适配器要提供请求级 header/cookie 计算，并允许上层设置来源白名单和 SSR 超时。
