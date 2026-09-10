'use client';

import * as React from 'react';
import { Check, Copy, TriangleAlert } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button, type ButtonProps } from './button';

type CopyState = 'idle' | 'copied' | 'error';

/** How long the confirmation icon stays before reverting, in ms. */
const RESET_DELAY = 1500;

/**
 * The Clipboard API is unavailable in insecure contexts and in some embedded
 * webviews, and `writeText` rejects when the document is not focused. Both are
 * ordinary runtime conditions, not bugs, so they resolve to `false` and the
 * button reports the failure instead of throwing.
 */
async function writeToClipboard(value: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export interface CopyButtonProps extends Omit<ButtonProps, 'children' | 'onClick' | 'value' | 'asChild'> {
  /** The exact text placed on the clipboard. */
  value: string;
  /** Accessible name and, when `showLabel`, the visible text. */
  label?: string;
  copiedLabel?: string;
  errorLabel?: string;
  /** Render the label beside the icon instead of an icon-only button. */
  showLabel?: boolean;
  onCopied?: (value: string) => void;
}

/**
 * Copy affordance for URLs, ids, API keys and generated snippets. The result is
 * announced through a polite live region because the icon swap alone is
 * invisible to screen-reader users.
 */
const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(function CopyButton(
  {
    value,
    label = 'Copy',
    copiedLabel = 'Copied',
    errorLabel = 'Copying is not available in this browser',
    showLabel = false,
    onCopied,
    variant = 'ghost',
    size,
    className,
    ...props
  },
  ref,
) {
  const [state, setState] = React.useState<CopyState>('idle');
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = React.useRef(false);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const handleClick = React.useCallback(async () => {
    const ok = await writeToClipboard(value);
    // The write happened either way, so tell the caller before checking whether
    // this button is still on screen.
    if (ok) onCopied?.(value);

    // Copy buttons live in rows and popovers that routinely close mid-write.
    // Scheduling the reset after unmount would leave a timer the cleanup above
    // has already run past — it would fire on a dead component.
    if (!mounted.current) return;

    setState(ok ? 'copied' : 'error');
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), RESET_DELAY);
  }, [value, onCopied]);

  const Icon = state === 'copied' ? Check : state === 'error' ? TriangleAlert : Copy;
  const currentLabel = state === 'copied' ? copiedLabel : state === 'error' ? errorLabel : label;

  return (
    <>
      <Button
        {...props}
        ref={ref}
        variant={variant}
        size={size ?? (showLabel ? 'sm' : 'icon')}
        aria-label={showLabel ? undefined : currentLabel}
        title={showLabel ? undefined : currentLabel}
        className={cn(
          !showLabel && 'size-7 text-muted-foreground hover:text-foreground',
          state === 'copied' && 'text-success hover:text-success',
          state === 'error' && 'text-destructive hover:text-destructive',
          className,
        )}
        onClick={() => {
          void handleClick();
        }}
      >
        <Icon aria-hidden="true" />
        {showLabel ? <span>{state === 'idle' ? label : currentLabel}</span> : null}
      </Button>
      <span aria-live="polite" className="sr-only">
        {state === 'idle' ? '' : currentLabel}
      </span>
    </>
  );
});

export { CopyButton };
