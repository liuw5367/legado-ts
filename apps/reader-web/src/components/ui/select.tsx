import type { SelectHTMLAttributes } from 'react'
import { cn } from '../../lib/utils.ts'

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn('select', className)} />
}
