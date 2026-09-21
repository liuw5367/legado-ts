import type { DiagnosticCode, DiagnosticSeverity, DiagnosticStage, ImportDiagnostic } from '../model/types.ts'

export function diagnostic(
  code: DiagnosticCode,
  stage: DiagnosticStage,
  message: string,
  options: {
    severity?: DiagnosticSeverity
    path?: string
    retryable?: boolean
  } = {},
): ImportDiagnostic {
  const result: ImportDiagnostic = {
    code,
    severity: options.severity ?? 'error',
    stage,
    message,
    retryable: options.retryable ?? false,
  }
  if (options.path !== undefined) result.path = options.path
  return result
}

export function primaryError(diagnostics: readonly ImportDiagnostic[]): ImportDiagnostic | undefined {
  return diagnostics.find((item) => item.severity === 'error')
}

export function safeLocation(location: string | undefined): string | undefined {
  if (location === undefined) return undefined
  try {
    const parsed = new URL(location)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    return parsed.toString()
  } catch {
    return location.length > 160 ? `${location.slice(0, 157)}...` : location
  }
}
