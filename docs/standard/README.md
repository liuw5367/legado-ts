# 标准与政策入口（历史路径）

Android 规则标准已经按来源与责任拆分：

- [Android 规则来源](../upstream/android/rules/source-schema.md)：字段和领域模型。
- [Android 规则语言](../upstream/android/rules/rule-language.md)：规则模式、链和变量。
- [Android JavaScript 书源](../upstream/android/rules/javascript-source.md)：函数、绑定和返回值。
- [Android URL 与请求规则](../upstream/android/rules/url-request-rules.md)：展开、请求选项、Cookie 和重定向。
- [Android 字段所有权](../upstream/android/rules/source-field-ownership.md)：导入、订阅和管理字段的 Android 行为。
- [Android 实体边界](../upstream/android/rules/artifact-model.md)：BookSource、RssSource、ReplaceRule 和 RuleSub。
- [Android 校验状态](../upstream/android/rules/source-check-state.md)：NEEDS_CHECK/PASSED/FAILED、revision 和迟到结果。

跨 package 的项目政策见[兼容政策](../contracts/compatibility-policy.md)，当前 TypeScript 行为见 [`@legado/source-core`](../../packages/source-core/README.md) 与 [`@legado/source-node`](../../packages/source-node/README.md)，差异和证据见[兼容性与验证](../compatibility/README.md)。本目录保留为历史入口，后续新增标准不得继续放入这里。
