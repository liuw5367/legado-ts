import { JSONPath } from 'jsonpath-plus'
import type { JsonPathParser, RuleValue } from '@legado/source-core'

export class JsonPathParserAdapter implements JsonPathParser {
  public evaluate(value: unknown, expression: string): RuleValue | null {
    const result = JSONPath({ path: expression, json: value as never, wrap: true, eval: false }) as unknown
    return result === undefined ? [] : result as RuleValue
  }
}
