export const IMPORT_FILE_MAX_BYTES = 20 * 1024 * 1024
// JSON 字符串序列化会转义引号和反斜线，另为来源链接和请求字段保留空间。
export const IMPORT_REQUEST_MAX_BYTES = 2 * IMPORT_FILE_MAX_BYTES + 64 * 1024
