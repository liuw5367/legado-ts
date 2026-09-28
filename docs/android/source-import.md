🥷 本文记录 Android 书源导入弹窗从输入识别、解析、替换规则、本地比较到最终保存的完整流程。

# 书源导入

## 输入识别

入口主要是 `ui/association/ImportBookSourceDialog.kt` 和 `ImportBookSourceViewModel.kt`。导入任务只允许启动一次，开始后由 `sourceUpdatePending` 禁止重复确认和关闭。

输入去除首尾空白后按顺序判断：

1. JSON 对象或数组，解析为一个或多个书源。
2. 绝对 URL，下载并解压响应后再次解析。
3. Android URI，读取本地文件后解析。
4. 其他文本，作为 JS 书源配置交给 `JsSourceConfig.extract`。

JSON 既可以直接包含书源，也可以包含 `sourceUrls`，后者会递归下载每个 URL。在线 URL 以 `#requestWithoutUA` 结尾时去掉标记并使用特殊请求头。

解析、下载、解压或 JS 提取失败时发布 `ImportError`，写入 `AppLog`，不会打开候选列表。

## 候选准备和替换规则

解析成功后加载当前启用的替换规则，为每个书源生成 `BookSourceImportCandidate`。替换有两种模式：

- 自动模式：使用导入范围内全部启用替换规则。
- 手动模式：为单个或全部候选选择规则 ID。

候选同时保留原始 JSON、替换后的 JSON、实际生效规则 ID 和替换错误。替换失败时候选不可导入，但其他候选仍可继续确认。切换自动和手动模式会重新生成候选，比较失败时恢复上一组候选状态。

## 与本地书源比较

按 `bookSourceUrl` 查询本地 `BookSourcePart`，只比较 `lastUpdateTime`：

- 本地没有对应 URL，状态为新增。
- 本地存在且导入时间更晚，状态为更新。
- 本地存在且导入时间不晚，状态为已存在。

新增和更新默认选中，已存在默认不选。书源重新导入场景可以强制选择当前来源，即使时间没有变化。手动勾选会记录在 `manualSelections`，重新应用替换规则时尽量保留。

候选列表还支持按名称、URL、分组、备注、启用状态、登录状态和发现开关筛选。筛选只影响显示索引，不改变候选和选择状态。

## 导入前的选项

确认前可以设置：

- 是否保留本地书源名称。
- 是否保留本地分组。
- 是否保留本地启用和启用发现状态。
- 是否显示备注。
- 是否记住下次导入的目标分组。
- 目标分组是覆盖原分组，还是追加到原分组。
- 是否自动应用替换规则。
- 单个候选使用哪些手动替换规则。

点击候选的编辑按钮会打开代码弹窗。保存代码后重新解析该候选、重新比较本地版本并更新新增或更新状态。代码格式错误只影响当前候选，不会直接保存。

## 确认保存

`importSelect` 在后台构造最终书源：

1. 只遍历已选且 `canImportSource=true` 的候选。
2. 按选项恢复本地名称、分组、启用状态和 `customOrder`。
3. 按目标分组选项覆盖或追加分组。
4. 在 `NonCancellable` 中调用 `SourceHelp.insertBookSource`，并刷新 `ContentProcessor` 的替换规则。
5. 如果这是阅读页重新导入当前来源，保存成功后更新 `ReadBook.bookSource`。
6. 设置 `importFinished=true`，弹窗关闭。

数据库写入一旦开始，即使弹窗被销毁也会继续完成。写入失败才发布错误状态，已保存的候选不会在 UI 关闭时回滚。

## 界面状态和取消

- 初始阶段显示旋转加载。
- 候选解析成功但数量为零时显示格式错误或无结果。
- `sourceUpdatePending=true` 时禁止编辑、选择、替换规则和取消。
- 导入确认使用等待弹窗，防止重复提交。
- 用户在真正保存前可以关闭弹窗，已解析的候选不会写入数据库。
- 替换规则刷新、代码编辑和候选比较都有独立的错误提示和日志。

源码证据：`ui/association/ImportBookSourceViewModel.kt:37-230, 232-469`、`ImportBookSourceDialog.kt:88-240, 250-597`、`ui/association/BookSourceImport.kt`、`model/JsSourceConfig.kt`。
