import { z } from 'zod'

export const MIN_SEARCH_CONCURRENCY = 5
export const MAX_SEARCH_CONCURRENCY = 20
export const DEFAULT_SEARCH_CONCURRENCY = 10
export const searchConcurrencySchema = z.number().int().min(MIN_SEARCH_CONCURRENCY).max(MAX_SEARCH_CONCURRENCY)
