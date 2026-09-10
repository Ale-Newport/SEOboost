'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import { useFormControl } from './form-field';

export const inputClassName = [
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground shadow-xs',
  'transition-colors placeholder:text-muted-foreground',
  'focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 focus-visible:ring-offset-0',
  'disabled:cursor-not-allowed disabled:opacity-60',
  'aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/25',
  'file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
].join(' ');

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input({ className, type = 'text', ...props }, ref) {
  const field = useFormControl(props);

  return (
    <input
      {...props}
      {...field}
      ref={ref}
      type={type}
      className={cn(inputClassName, type === 'number' && 'tabular', className)}
    />
  );
});

export { Input };
