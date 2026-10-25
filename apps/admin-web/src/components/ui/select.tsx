import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** Native select styled like shadcn inputs (accessible and light on mobile). */
export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm',
        className,
      )}
      {...props}
    />
  );
}
