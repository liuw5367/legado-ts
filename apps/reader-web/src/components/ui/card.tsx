import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/utils.ts'

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section {...props} className={cn('card', className)} />
}
