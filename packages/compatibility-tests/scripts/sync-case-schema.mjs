import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { root, readJson } from './common.mjs'

// operation 的输入字段只维护在 operations.json，此脚本生成编辑器需要的条件 schema。
export function operationSchemas(operations) {
  return Object.entries(operations).map(([operation, shape]) => ({
    if: { properties: { operation: { const: operation } } },
    then: { properties: { input: { type: 'object', required: shape.required, properties: Object.fromEntries(Object.entries(shape.properties).map(([key, type]) => [key, type === 'strings' ? { type: 'array', items: { type: 'string' } } : type === 'objects' ? { type: 'array', items: { type: 'object' } } : { type }])), additionalProperties: false } } },
  }))
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const operations = await readJson(join(root, 'schema/operations.json'))
  const schema = await readJson(join(root, 'schema/case.schema.json'))
  schema.properties.operation.enum = Object.keys(operations)
  schema.allOf = operationSchemas(operations)
  await writeFile(join(root, 'schema/case.schema.json'), JSON.stringify(schema, null, 2) + '\n')
}
