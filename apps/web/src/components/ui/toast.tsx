'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { Toaster as SonnerToaster, toast, type ToasterProps } from 'sonner';

import { cn } from '@/lib/utils';

/** Narrow next-themes' free-form string to the three values sonner accepts. */
function resolveToasterTheme(theme: string | undefined): NonNullable<ToasterProps['theme']> {
  return theme === 'light' || theme === 'dark' ? theme : 'system';
}

/**
 * Sonner, restyled onto our tokens. Sonner ships its own CSS variables; we
 * override with class names instead so toasts follow the same light/dark
 * palette as every other surface without importing its stylesheet.
 */
function Toaster({ className, toastOptions, ...props }: ToasterProps): React.JSX.Element {
  const { resolvedTheme } = useTheme();

  return (
    <SonnerToaster
      theme={resolveToasterTheme(resolvedTheme)}
      position="bottom-right"
      offset={16}
      gap={8}
      className={cn('toaster group', className)}
      toastOptions={{
        ...toastOptions,
        classNames: {
          toast:
            'group toast flex w-full items-start gap-3 rounded-lg border border-border bg-popover p-3.5 text-popover-foreground shadow-lg',
          title: 'text-sm font-medium leading-tight',
          description: 'text-sm leading-relaxed text-muted-foreground',
          actionButton:
            'inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground',
          cancelButton:
            'inline-flex h-7 items-center rounded-md bg-secondary px-2.5 text-xs font-medium text-secondary-foreground',
          closeButton: 'border-border bg-popover text-muted-foreground hover:text-foreground',
          error: 'border-destructive/30 [&_[data-icon]]:text-destructive',
          success: 'border-success/30 [&_[data-icon]]:text-success',
          warning: 'border-warning/30 [&_[data-icon]]:text-warning',
          info: 'border-info/30 [&_[data-icon]]:text-info',
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  );
}

export { Toaster, toast };
export type { ToasterProps };
