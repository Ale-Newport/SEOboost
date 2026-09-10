'use client';

import { useCallback, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiPost } from '@/lib/api-client';
import { IssueList, ValidationBadge } from './json-ld-block';
import { countErrors, type ValidateResponse } from './types';

/**
 * Paste-in validator for markup that is already on a page (or about to be).
 *
 * It posts to the same `/api/schema/validate` route the generator and the deploy path use, so a
 * verdict here is the verdict everywhere. Nothing is stored: no `itemId` is sent, which is what
 * makes this safe to run against a competitor's markup or a half-written draft.
 */
export function ValidateJsonLdTool(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState('');
  const [result, setResult] = useState<ValidateResponse | null>(null);
  const [running, setRunning] = useState(false);

  const reset = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setRaw('');
      setResult(null);
    }
  }, []);

  async function validate(): Promise<void> {
    const text = raw.trim();
    if (text.length === 0) return;
    setRunning(true);
    try {
      // `raw` rather than `jsonLd`: a paste usually has its own syntax errors, and the route
      // reports those separately from the schema ones.
      const response = await apiPost<ValidateResponse>('/api/schema/validate', { raw: text });
      setResult(response);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'The markup could not be validated.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          Validate JSON-LD
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Validate JSON-LD</DialogTitle>
          <DialogDescription>
            Paste a block — with or without its <code className="font-mono">&lt;script&gt;</code> wrapper — to check
            it against the required and recommended properties Google documents for each type. Nothing is saved.
          </DialogDescription>
        </DialogHeader>

        <FormField
          label="JSON-LD"
          description="An object or an array of objects. Trailing commas and HTML comment wrappers are tolerated."
        >
          <Textarea
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            rows={10}
            spellCheck={false}
            placeholder={'{\n  "@context": "https://schema.org",\n  "@type": "Organization",\n  "name": "Acme"\n}'}
            className="font-mono text-2xs"
          />
        </FormField>

        {result === null ? null : (
          <div className="space-y-2.5" role="status" aria-live="polite">
            <div className="flex flex-wrap items-center gap-1.5">
              <ValidationBadge status={result.status} errorCount={countErrors(result.issues)} />
              {result.types.length > 0 ? (
                result.types.map((type, index) => (
                  <Badge key={`${type}-${index}`} variant="outline">
                    {type}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">No @type found</span>
              )}
            </div>
            <IssueList
              issues={result.issues}
              emptyMessage="Every required and recommended property is present."
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => reset(false)}>
            Close
          </Button>
          <Button
            size="sm"
            onClick={() => void validate()}
            loading={running}
            loadingText="Validating"
            disabled={raw.trim().length === 0}
          >
            Validate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
