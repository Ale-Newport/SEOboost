'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/**
 * Shared shell for every settings block on this screen.
 *
 * One pattern, applied everywhere: edits are local until you press Save, the button is disabled
 * while nothing has changed, and Discard restores exactly what the server last returned. A
 * settings page that autosaves is a settings page you cannot back out of.
 */

/** Runs one mutation, reports it, and refreshes the server component tree on success. */
export function useSaveHandler(): {
  pending: boolean;
  run: (mutate: () => Promise<void>, success: string) => Promise<boolean>;
} {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const run = useCallback(
    async (mutate: () => Promise<void>, success: string): Promise<boolean> => {
      setPending(true);
      try {
        await mutate();
        toast.success(success);
        router.refresh();
        return true;
      } catch (cause) {
        toast.error(
          cause instanceof ApiError
            ? cause.message
            : cause instanceof Error && cause.message
              ? cause.message
              : 'Could not save the change.',
        );
        return false;
      } finally {
        setPending(false);
      }
    },
    [router],
  );

  return { pending, run };
}

export interface SettingsSectionProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  dirty: boolean;
  pending: boolean;
  onSave: () => void;
  onReset: () => void;
  saveLabel?: string;
  /** Blocks saving with a reason, e.g. a validation failure the fields already explain. */
  blockedReason?: string | null;
  footerNote?: React.ReactNode;
}

export function SettingsSection({
  title,
  description,
  children,
  dirty,
  pending,
  onSave,
  onReset,
  saveLabel = 'Save changes',
  blockedReason = null,
  footerNote,
}: SettingsSectionProps): React.JSX.Element {
  return (
    <Card>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!dirty || blockedReason) return;
          onSave();
        }}
      >
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>

        <CardContent className="space-y-5">{children}</CardContent>

        <CardFooter className="flex-wrap justify-between gap-3">
          <p
            role="status"
            className={cn('text-2xs', blockedReason ? 'text-destructive' : 'text-muted-foreground')}
          >
            {blockedReason ?? (dirty ? 'Unsaved changes' : (footerNote ?? 'Everything here is saved.'))}
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onReset} disabled={!dirty || pending}>
              Discard
            </Button>
            <Button
              type="submit"
              size="sm"
              loading={pending}
              loadingText="Saving"
              disabled={!dirty || blockedReason !== null}
            >
              {saveLabel}
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}

export interface ListFieldProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  rows?: number;
  id: string;
}

/**
 * One entry per line.
 *
 * Line-separated rather than comma-separated because every list on this screen can legitimately
 * contain a comma — a URL pattern, a prohibited claim, a value proposition.
 */
export function ListField({
  label,
  description,
  value,
  onChange,
  placeholder,
  rows = 3,
  id,
}: ListFieldProps): React.JSX.Element {
  // The raw text is local so a half-typed line (or a trailing space) survives the keystroke;
  // the parsed list is what leaves the component.
  const [text, setText] = useState(value.join('\n'));

  useEffect(() => {
    // Only re-seed when the parent's value is genuinely different — a Discard, or a fresh load.
    if (!isSame(parseLines(text), value)) setText(value.join('\n'));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- text is the draft, not an input
  }, [value]);

  return (
    <FormField label={label} htmlFor={id} {...(description ? { description } : {})}>
      <Textarea
        id={id}
        rows={rows}
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        className="font-mono text-xs"
        onChange={(event) => {
          setText(event.target.value);
          onChange(parseLines(event.target.value));
        }}
      />
    </FormField>
  );
}

/** One entry per non-blank line, trimmed. */
function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Compares two settings drafts by value, so the Save button reflects real changes only. */
export function isSame<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether a numeric field is unacceptable — out of bounds, or not a number at all.
 *
 * The `NaN` half matters more than the bounds half. Clearing a `type="number"` input yields an
 * empty string, and `Number('')` is `NaN`, which compares `false` against every bound — so a
 * plain `value < min || value > max` check reports a cleared field as valid, and `JSON.stringify`
 * then sends it to the API as `null`. Anything non-finite is rejected here instead.
 */
export function outsideRange(value: number, min: number, max: number): boolean {
  return !Number.isFinite(value) || value < min || value > max;
}
