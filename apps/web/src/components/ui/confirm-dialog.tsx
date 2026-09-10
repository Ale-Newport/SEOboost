'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from './alert';
import { Button } from './button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';
import { FormField } from './form-field';
import { Input } from './input';

/**
 * Local rather than `errorMessage` from `@seo/shared`: this is a client
 * component, and importing the shared barrel would pull server-only modules
 * (env, crypto) into the browser bundle.
 */
function toMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'Something went wrong. Please try again.';
}

export interface ConfirmOptions {
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button — deletions, disconnects, anything that loses data. */
  destructive?: boolean;
  /**
   * Requires the operator to type this exact string first. Reserve it for
   * actions that are irreversible at scale (deleting a website and its crawl
   * history, rolling back a deployed change).
   */
  confirmationText?: string;
  /** Replaces the default “Type X to confirm” instruction. */
  confirmationHint?: React.ReactNode;
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Awaited before the dialog closes. If it rejects, the dialog stays open and
   * shows the message — a failed destructive action must never look like it
   * succeeded.
   */
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
  className?: string;
}

/**
 * Confirmation gate for destructive and high-risk actions.
 *
 * While the action is in flight the dialog cannot be dismissed by escape, an
 * outside click or the close button, so a half-finished delete can't be hidden
 * by a stray click.
 */
function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  onCancel,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  confirmationText,
  confirmationHint,
  className,
}: ConfirmDialogProps): React.JSX.Element {
  const [typed, setTyped] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Each opening is a fresh decision: never carry a previous attempt's typed
  // confirmation or error message into the next one.
  React.useEffect(() => {
    if (open) {
      setTyped('');
      setError(null);
      setPending(false);
    }
  }, [open]);

  const confirmationSatisfied = confirmationText === undefined || typed.trim() === confirmationText;

  async function handleConfirm(): Promise<void> {
    if (!confirmationSatisfied || pending) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (cause) {
      setError(toMessage(cause));
    } finally {
      setPending(false);
    }
  }

  function handleCancel(): void {
    if (pending) return;
    onCancel?.();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) onCancel?.();
        onOpenChange(next);
      }}
    >
      <DialogContent
        className={cn('max-w-md', className)}
        hideCloseButton={pending}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        {confirmationText !== undefined ? (
          <FormField
            label={confirmationHint ?? <>Type <span className="font-mono">{confirmationText}</span> to confirm</>}
          >
            <Input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={pending}
              className="font-mono"
            />
          </FormField>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            loading={pending}
            loadingText={`${confirmLabel} in progress`}
            disabled={!confirmationSatisfied}
            onClick={() => {
              void handleConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface UseConfirmResult {
  /** Resolves `true` when confirmed, `false` on cancel, dismissal or unmount. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** Render this once inside the component that called `useConfirm`. */
  confirmDialog: React.ReactNode;
}

/**
 * Promise-based confirmation, so a handler reads top to bottom:
 *
 * ```tsx
 * const { confirm, confirmDialog } = useConfirm();
 * async function remove() {
 *   if (!(await confirm({ title: 'Delete website?', destructive: true }))) return;
 *   await deleteWebsite(id);
 * }
 * return <>{confirmDialog}<Button onClick={remove}>Delete</Button></>;
 * ```
 *
 * The dialog element is returned rather than mounted at the app root: the
 * decision belongs to the screen that asked, and there is no provider to forget.
 *
 * The dialog closes as soon as the answer is known, so the caller's action runs
 * *after* it is gone. When the action must keep the dialog open — and
 * undismissable — while it is in flight, render `<ConfirmDialog>` directly and
 * hand it an async `onConfirm`.
 */
export function useConfirm(): UseConfirmResult {
  // The id is part of the state so each request gets its own dialog element:
  // a supersede does not change `open`, so without a new key the next prompt
  // would inherit the previous one's typed confirmation text and error message
  // — i.e. an already-armed confirm button for an action nobody confirmed.
  const [request, setRequest] = React.useState<{ id: number; options: ConfirmOptions } | null>(null);
  const [open, setOpen] = React.useState(false);
  const requestId = React.useRef(0);
  const resolver = React.useRef<((confirmed: boolean) => void) | null>(null);

  const settle = React.useCallback((confirmed: boolean) => {
    resolver.current?.(confirmed);
    resolver.current = null;
    // The request is deliberately kept so the close animation still has content.
    setOpen(false);
  }, []);

  const confirm = React.useCallback((next: ConfirmOptions) => {
    // A second request while one is open cancels the first; leaving an awaited
    // promise unresolved would hang its caller forever.
    resolver.current?.(false);
    resolver.current = null;

    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      requestId.current += 1;
      setRequest({ id: requestId.current, options: next });
      setOpen(true);
    });
  }, []);

  React.useEffect(() => {
    return () => {
      resolver.current?.(false);
      resolver.current = null;
    };
  }, []);

  const confirmDialog = request ? (
    <ConfirmDialog
      key={request.id}
      {...request.options}
      open={open}
      onOpenChange={(next) => {
        if (!next) settle(false);
      }}
      onConfirm={() => settle(true)}
    />
  ) : null;

  return { confirm, confirmDialog };
}

export { ConfirmDialog };
