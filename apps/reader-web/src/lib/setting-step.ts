/** 行距以十分之一的整数步进，避免浮点累计误差。 */
export function stepSetting(value: number, direction: -1 | 1, min: number, max: number, step: number) {
  const next = (Math.round(value / step) + direction) * step
  return Math.min(max, Math.max(min, Number(next.toFixed(1))))
}
