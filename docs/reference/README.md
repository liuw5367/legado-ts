# 参考规范

本目录定义实现必须遵守的稳定事实和目标契约。字段、规则、请求、JavaScript、宿主、能力、身份和副作用的具体语义只在这里维护；流程文档和实施文档引用这些内容，不另写一套规则。

- [书源数据模型](source-schema.md)：书源、规则对象、领域输出和字段注释。
- [字段所有权与合并规则](source-field-ownership.md)：源配置、用户状态、订阅更新和导出回写。
- [书源相关实体边界](artifact-model.md)：BookSource、RssSource、ReplaceRule 和订阅实体。
- [规则语言与解析器](rule-language.md)：规则扫描、模式识别、求值和变量语义。
- [URL 与请求规则](url-request-rules.md)：URL 展开、请求选项、响应字节和安全边界。
- [JavaScript 书源](javascript-source.md)：函数约定、绑定、返回值和脚本 scope。
- [TypeScript 宿主接口](runtime-host-interfaces.md)：核心与宿主之间的端口和错误契约。
- [运行时统一契约](runtime-contracts.md)：版本、请求计划、结果、副作用和错误命名。
- [书源能力清单与审核决策](capability-inventory.md)：能力登记、优先级、证据和待审核项目。
- [身份、状态与副作用](state-and-effects.md)：身份、版本、所有权、取消和提交语义。
- [书源管理与状态](source-management-and-state.md)：书源保存、更新、删除、版本和运行状态的边界。
- [书源校验状态](source-check-state.md)：校验会话、阶段、结果和旧结果拒绝写回。

本目录的文档可能同时包含“源码事实”“兼容要求”“目标设计”和“待验证”内容，具体状态以文档正文和 [质量文档](../quality/README.md) 为准。
