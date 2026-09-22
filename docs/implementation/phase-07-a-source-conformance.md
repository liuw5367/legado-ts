# 任务 07-A：书源解析兼容测试

本任务从任务 11 的全局质量门禁中拆出书源运行时专属的一致性测试。它验证 `source-core`、`source-node` 与 Android 书源行为之间的规则、请求、解析器、JavaScript 和工作流契约。

## 覆盖范围

- schema/import、未知字段、数组展开和静态/动态 JavaScript 诊断；
- 规则扫描、组合符、索引、正则、变量、替换和能力缺失；
- URL 规划、编码、Header/Body、Cookie、重定向、响应预算和取消；
- HTML/CSS、XPath、JSONPath、字符集和节点身份；
- QuickJS 隔离、变量 bridge、预算、取消和序列化；
- 发现、搜索、详情、目录、正文、分页、缓存和 partial 结果；
- 编码、加密、字体和并发等宿主能力的书源级结果。

每个案例记录 Android evidence、输入、稳定输出、错误阶段、允许差异、资源清理和 TypeScript execution。没有 Android 对照的 Web 新设计只能标记为 design，不得标记 verified。

## 测试边界

默认不访问公网、不写外部服务、不依赖真实账号。网络语义使用本地受控 HTTP server；脚本和字体输入使用脱敏 fixture。任务 11 负责汇总本任务结果、运行发布门禁和更新全局矩阵，本任务负责书源案例本身。

## 完成标准

从公开 package 入口执行规则、请求、解析器和工作流组合案例；成功、合法空结果、失败、能力缺失、取消、预算耗尽和清理结果均可判别；Android 对照案例不能由实现输出反向生成。
