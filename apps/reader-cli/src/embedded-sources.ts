export interface EmbeddedSourceInput {
  /** 构建时嵌入的书源原文。 */
  text: string
  /** 用于诊断和 source-core 导入来源标识的稳定位置。 */
  location: string
}

let sourceInputs: readonly EmbeddedSourceInput[] = []

/**
 * 设置当前二进制提供的内置书源。
 *
 * 构建入口在调用 CLI 主函数前设置它；普通 Node 入口保持空数组，继续要求外部来源。
 */
export function setEmbeddedSourceInputs(inputs: readonly EmbeddedSourceInput[]): void {
  sourceInputs = inputs
}

export function getEmbeddedSourceInputs(): readonly EmbeddedSourceInput[] {
  return sourceInputs
}
