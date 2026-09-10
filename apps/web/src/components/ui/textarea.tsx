'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import { useFormControl } from './form-field';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, rows = 4, ...props },
  ref,
) {
  const field = useFormControl(props);

  return (
    <textarea
      {...props}
      {...field}
      ref={ref}
      rows={rows}
      className={cn(
        'flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground shadow-xs',
        'transition-colors placeholder:text-muted-foreground',
        'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25',
        'disabled:cursor-not-allowed disabled:opacity-60',
        'aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/25',
        className,
      )}
    />
  );
});

export { Textarea };
