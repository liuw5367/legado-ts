import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/utils.ts'

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} className={cn('badge', className)} />
}
