import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/utils.ts'

export type ButtonVariant = 'default' | 'secondary'
export type ButtonSize = 'default' | 'sm'

export function buttonVariants({ variant = 'default', size = 'default', className }: { variant?: ButtonVariant; size?: ButtonSize; className?: string | undefined } = {}): string {
  return cn('button', variant === 'secondary' && 'secondary', size === 'sm' && 'small', className)
}

export function Button({ className, variant = 'default', size = 'default', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button {...props} className={buttonVariants({ variant, size, className })} />
}
