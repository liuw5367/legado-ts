import { z } from 'zod'

export const sourceLoginUiSchema = z.object({
  sourceId: z.string().trim().min(1).max(2000),
  fingerprint: z.string().trim().min(1).max(200).optional(),
})

export const sourceLoginActionSchema = z.object({
  sourceId: z.string().trim().min(1).max(2000),
  fingerprint: z.string().trim().min(1).max(200),
  action: z.string().trim().max(32_768).optional(),
  state: z.unknown().optional(),
  form: z.record(z.string(), z.string().max(16_384)).refine((value) => Object.keys(value).length <= 64, '登录字段过多'),
})

export type SourceLoginUiInput = z.infer<typeof sourceLoginUiSchema>
export type SourceLoginActionInput = z.infer<typeof sourceLoginActionSchema>

export interface SourceLoginField {
  name: string
  type: 'text' | 'password' | 'button' | 'label' | 'toggle' | 'select' | string
  default?: string
  value?: string
  chars?: Array<string | null>
  options?: string[]
  hint?: string
  key?: string
  action?: string
  countdown?: number
}

export interface SourceLoginUi {
  sourceId: string
  fingerprint: string
  fields: SourceLoginField[]
  values: Record<string, string>
  dynamic: boolean
  state?: unknown
  actions?: SourceLoginWorkflowAction[]
}

export interface SourceLoginActionResult {
  sourceId: string
  fingerprint: string
  values: Record<string, string>
  fields?: SourceLoginField[]
  result?: unknown
  state?: unknown
  errors?: Record<string, string>
  close?: boolean
  capabilityMissing?: boolean
  actions?: SourceLoginWorkflowAction[]
}

export interface SourceLoginWorkflowAction {
  action: 'upUiData' | 'reUiView' | 'refreshExplore' | 'refreshBookInfo' | 'refreshBookToc' | 'refreshContent' | 'reGetBook' | 'refreshTocUrl' | 'copyText' | 'clearTtsCache' | 'searchBook' | 'addBook' | 'showPhoto' | 'open' | 'saveInfoMap'
}
