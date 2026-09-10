'use client';

import * as React from 'react';
import { RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { humanizeKey } from '@/components/actions/json-view';

/**
 * Edit-then-approve.
 *
 * The operator is fixing the agent's proposal, so the editor works on the payload the executor
 * will actually apply — not on a rendering of it. Text values get a real field each; anything
 * that is not a string (link arrays, JSON-LD graphs) stays as JSON, because silently flattening
 * a structure into a text box is how an approved change stops matching what was reviewed.
 *
 * Nothing is sent until the JSON parses. An unparseable remainder blocks saving rather than
 * being dropped.
 */

/** Anything longer than this gets a textarea rather than a single-line input. */
const MULTILINE_AT = 80;

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function splitPayload(payload: Record<string, unknown>): {
  text: Array<[string, string]>;
  rest: Record<string, unknown>;
} {
  const text: Array<[string, string]> = [];
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (isString(value)) text.push([key, value]);
    else rest[key] = value;
  }
  return { text, rest };
}

export interface PayloadEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The approval's title, for the dialog description. */
  title: string;
  /** The payload as it stands now — the agent's, or the operator's previous edit. */
  payload: Record<string, unknown>;
  /** The agent's untouched proposal, so "Reset" is always available. */
  originalPayload: Record<string, unknown>;
  /** Keep the edit and return to the diff without deciding. */
  onSave: (next: Record<string, unknown>) => void;
  /** Keep the edit and approve in the same step. */
  onSaveAndApprove: (next: Record<string, unknown>) => void;
  pending: boolean;
}

export function PayloadEditor({
  open,
  onOpenChange,
  title,
  payload,
  originalPayload,
  onSave,
  onSaveAndApprove,
  pending,
}: PayloadEditorProps): React.JSX.Element {
  const initial = React.useMemo(() => splitPayload(payload), [payload]);

  const [fields, setFields] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(initial.text),
  );
  const [restJson, setRestJson] = React.useState(() =>
    Object.keys(initial.rest).length === 0 ? '' : JSON.stringify(initial.rest, null, 2),
  );
  const [restError, setRestError] = React.useState<string | null>(null);

  // Re-seed whenever the dialog is opened against a different payload, so reopening after a
  // reset or a save never shows a stale draft.
  React.useEffect(() => {
    if (!open) return;
    const split = splitPayload(payload);
    setFields(Object.fromEntries(split.text));
    setRestJson(Object.keys(split.rest).length === 0 ? '' : JSON.stringify(split.rest, null, 2));
    setRestError(null);
  }, [open, payload]);

  const fieldKeys = React.useMemo(() => Object.keys(fields), [fields]);

  const build = (): Record<string, unknown> | null => {
    let rest: Record<string, unknown> = {};
    const trimmed = restJson.trim();
    if (trimmed.length > 0) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setRestError('The remaining payload has to be a JSON object, e.g. { "links": [...] }.');
          return null;
        }
        rest = parsed as Record<string, unknown>;
      } catch (error) {
        setRestError(error instanceof Error ? error.message : 'That is not valid JSON.');
        return null;
      }
    }
    setRestError(null);
    return { ...rest, ...fields };
  };

  const reset = (): void => {
    const split = splitPayload(originalPayload);
    setFields(Object.fromEntries(split.text));
    setRestJson(Object.keys(split.rest).length === 0 ? '' : JSON.stringify(split.rest, null, 2));
    setRestError(null);
  };

  const empty = fieldKeys.length === 0 && restJson.trim().length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit before approving</DialogTitle>
          <DialogDescription>{title}</DialogDescription>
        </DialogHeader>

        <p className="rounded-md border border-info/25 bg-info/[0.07] px-3 py-2 text-xs leading-relaxed text-foreground">
          Approving applies exactly these values. The edit is stored on the approval, so the
          record shows what was signed off rather than what the agent first proposed.
        </p>

        <div className="max-h-[52vh] space-y-4 overflow-y-auto pr-1">
          {empty ? (
            <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              This approval carries no payload to edit. Approving it applies the action exactly as
              the agent recorded it.
            </p>
          ) : null}

          {fieldKeys.map((key) => {
            const value = fields[key] ?? '';
            const multiline = value.length > MULTILINE_AT || value.includes('\n');
            return (
              <FormField
                key={key}
                label={humanizeKey(key)}
                description={`${value.length} characters`}
              >
                {multiline ? (
                  <Textarea
                    value={value}
                    rows={Math.min(10, Math.max(3, Math.ceil(value.length / 90)))}
                    onChange={(event) =>
                      setFields((current) => ({ ...current, [key]: event.target.value }))
                    }
                  />
                ) : (
                  <Input
                    value={value}
                    onChange={(event) =>
                      setFields((current) => ({ ...current, [key]: event.target.value }))
                    }
                  />
                )}
              </FormField>
            );
          })}

          {restJson.length > 0 || Object.keys(initial.rest).length > 0 ? (
            <FormField
              label="Structured values"
              description="Link lists, JSON-LD and anything else that is not plain text. Edited as JSON so the shape the executor expects survives."
              {...(restError === null ? {} : { error: restError })}
            >
              <Textarea
                value={restJson}
                rows={10}
                spellCheck={false}
                className="font-mono text-2xs"
                onChange={(event) => {
                  setRestJson(event.target.value);
                  setRestError(null);
                }}
              />
            </FormField>
          ) : null}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" size="sm" onClick={reset} disabled={pending}>
            <RotateCcw aria-hidden="true" />
            Reset to the agent&apos;s proposal
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                const next = build();
                if (next !== null) onSave(next);
              }}
              disabled={pending}
            >
              Save and review
            </Button>
            <Button
              onClick={() => {
                const next = build();
                if (next !== null) onSaveAndApprove(next);
              }}
              loading={pending}
              loadingText="Approving"
            >
              Save and approve
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
