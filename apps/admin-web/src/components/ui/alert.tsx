import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const alertVariants = cva('w-full rounded-md border px-4 py-3 text-sm', {
  variants: {
    variant: {
      default: 'bg-background',
      destructive: 'border-destructive/50 bg-destructive/5 text-destructive',
      success: 'border-emerald-600/40 bg-emerald-50 text-emerald-800',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Alert({
  className,
  variant,
  ...props
}: ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}
