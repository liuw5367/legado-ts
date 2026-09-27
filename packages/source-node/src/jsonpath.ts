import { JSONPath } from 'jsonpath-plus'
import type { JsonPathParser, RuleValue } from '@legado/source-core'

export class JsonPathParserAdapter implements JsonPathParser {
  public evaluate(value: unknown, expression: string): RuleValue | null {
    // Android's Jayway JsonPath evaluates filter predicates. jsonpath-plus' safe
    // evaluator provides the same expression subset without enabling native JS.
    const result = JSONPath({ path: expression, json: value as never, wrap: true, eval: 'safe' }) as unknown
    return result === undefined ? [] : result as RuleValue
  }
}
