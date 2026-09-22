import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { SearchProgress } from './application.ts'
import type { OperationKind, SearchUiState, UiOperation } from './ui-model.ts'

interface UiOperationCallbacks {
  setBusy: Dispatch<SetStateAction<boolean>>
  setSearchProgress: Dispatch<SetStateAction<SearchProgress | undefined>>
  setSearchState: Dispatch<SetStateAction<SearchUiState>>
  setSourceSearchState: Dispatch<SetStateAction<SearchUiState>>
  setMessage: (text: string) => void
}

export interface UiOperationController {
  operationRef: { current: UiOperation | undefined }
  mountedRef: { current: boolean }
  beginOperation: (kind: OperationKind) => UiOperation
  isCurrent: (operation: UiOperation) => boolean
  finishOperation: (operation: UiOperation) => void
  cancelOperation: (text?: string) => void
  cancelActiveSearch: () => Promise<void>
}

export function useUiOperation(callbacks: UiOperationCallbacks): UiOperationController {
  const operationRef = useRef<UiOperation | undefined>(undefined)
  const nextOperationId = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => () => {
    mountedRef.current = false
    operationRef.current?.controller.abort()
  }, [])

  const beginOperation = (kind: OperationKind): UiOperation => {
    operationRef.current?.controller.abort()
    const operation: UiOperation = { id: nextOperationId.current + 1, kind, controller: new AbortController() }
    nextOperationId.current = operation.id
    operationRef.current = operation
    callbacks.setBusy(true)
    return operation
  }

  const isCurrent = (operation: UiOperation): boolean => operationRef.current?.id === operation.id

  const finishOperation = (operation: UiOperation): void => {
    if (!isCurrent(operation)) return
    operationRef.current = undefined
    if (!mountedRef.current) return
    callbacks.setBusy(false)
    callbacks.setSearchProgress(undefined)
  }

  const cancelOperation = (text = '操作已取消'): void => {
    const operation = operationRef.current
    operation?.controller.abort()
    operationRef.current = undefined
    callbacks.setBusy(false)
    callbacks.setSearchProgress(undefined)
    if (operation !== undefined) callbacks.setMessage(text)
  }

  const cancelActiveSearch = (): Promise<void> => {
    const operation = operationRef.current
    if (operation?.kind !== 'search' && operation?.kind !== 'source-search') return Promise.resolve()
    operation.controller.abort()
    callbacks.setBusy(true)
    callbacks.setMessage('正在取消搜索，等待书源请求释放…')
    if (operation.kind === 'search') callbacks.setSearchState('cancelling')
    else callbacks.setSourceSearchState('cancelling')
    return operation.promise?.then(() => undefined, () => undefined) ?? Promise.resolve()
  }

  return { operationRef, mountedRef, beginOperation, isCurrent, finishOperation, cancelOperation, cancelActiveSearch }
}
