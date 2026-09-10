'use client';

import { useCallback, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { ALWAYS_REQUIRES_APPROVAL, AUTONOMY_DESCRIPTIONS } from '@seo/shared/constants';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { ApiError, apiPatch } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/**
 * Autonomy is the single most consequential setting in the product, so the control shows the
 * *whole* ladder at once rather than a dropdown: every level, its description, and the exact
 * action types it will execute without asking. The list of auto-executed types is read from
 * `AUTONOMY_DESCRIPTIONS`, the same constant the guardrail layer enforces, so the screen cannot
 * promise behaviour the engine does not implement.
 */

type AutonomyKey = keyof typeof AUTONOMY_DESCRIPTIONS;

const LEVELS = Object.keys(AUTONOMY_DESCRIPTIONS) as AutonomyKey[];

/** `ADD_INTERNAL_LINKS` → `Add internal links`. */
function humanizeAction(type: string): string {
  const words = type.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface AutonomySelectorProps {
  websiteId: string;
  autonomyLevel: string;
  autoApproveSafe: boolean;
}

export function AutonomySelector({
  websiteId,
  autonomyLevel,
  autoApproveSafe,
}: AutonomySelectorProps): React.JSX.Element {
  const router = useRouter();
  const [level, setLevel] = useState<string>(autonomyLevel);
  const [safe, setSafe] = useState(autoApproveSafe);
  const [pending, setPending] = useState<'level' | 'safe' | null>(null);
  const safeId = useId();

  const save = useCallback(
    async (patch: Record<string, unknown>, kind: 'level' | 'safe', success: string) => {
      setPending(kind);
      try {
        await apiPatch(`/api/websites/${websiteId}/settings`, patch);
        toast.success(success);
        router.refresh();
        return true;
      } catch (cause) {
        toast.error(cause instanceof ApiError ? cause.message : 'Could not save the change.');
        return false;
      } finally {
        setPending(null);
      }
    },
    [router, websiteId],
  );

  const changeLevel = useCallback(
    async (next: string) => {
      const previous = level;
      setLevel(next);
      const ok = await save({ autonomyLevel: next }, 'level', 'Autonomy level updated');
      if (!ok) setLevel(previous);
    },
    [level, save],
  );

  const changeSafe = useCallback(
    async (next: boolean) => {
      setSafe(next);
      const ok = await save(
        { autoApproveSafe: next },
        'safe',
        next ? 'Safe actions are auto-approved' : 'Safe actions now wait for approval',
      );
      if (!ok) setSafe(!next);
    },
    [save],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck aria-hidden="true" className="size-4 text-primary" />
          Autonomy level
        </CardTitle>
        <CardDescription>
          How much this site&rsquo;s AI may do without you. Everything not listed as auto-executed
          is proposed and waits in Approvals.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <RadioGroup
          value={level}
          onValueChange={(next) => void changeLevel(next)}
          aria-label="Autonomy level"
          className="gap-2"
        >
          {LEVELS.map((key) => {
            const entry = AUTONOMY_DESCRIPTIONS[key];
            const selected = level === key;
            const optionId = `${safeId}-${key}`;

            return (
              <div
                key={key}
                className={cn(
                  'rounded-lg border p-3 transition-colors',
                  selected ? 'border-primary/50 bg-primary/[0.04]' : 'border-border hover:bg-accent/40',
                  pending === 'level' && 'opacity-70',
                )}
              >
                <div className="flex items-start gap-2.5">
                  <RadioGroupItem
                    id={optionId}
                    value={key}
                    className="mt-0.5"
                    disabled={pending !== null}
                    aria-describedby={`${optionId}-description`}
                  />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <label
                      htmlFor={optionId}
                      className="cursor-pointer text-sm font-medium leading-tight text-foreground"
                    >
                      {entry.label}
                    </label>
                    <p
                      id={`${optionId}-description`}
                      className="text-xs leading-relaxed text-muted-foreground"
                    >
                      {entry.description}
                    </p>

                    {entry.autoExecutes.length === 0 ? (
                      <p className="text-2xs font-medium text-muted-foreground">
                        Executes nothing automatically.
                      </p>
                    ) : (
                      <div className="space-y-1">
                        <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Executes without asking ({entry.autoExecutes.length})
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {entry.autoExecutes.map((type) => (
                            <Badge key={type} variant="secondary" className="text-2xs font-normal">
                              {humanizeAction(type)}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </RadioGroup>

        <Alert variant="neutral" icon={Lock}>
          <AlertTitle>These always need your approval</AlertTitle>
          <AlertDescription>
            <div className="mb-1 flex flex-wrap gap-1">
              {ALWAYS_REQUIRES_APPROVAL.map((type) => (
                <Badge key={type} variant="outline" className="text-2xs font-normal">
                  {humanizeAction(type)}
                </Badge>
              ))}
            </div>
            Redirects, page consolidations and custom actions are never executed automatically, at
            any level. The guardrail is enforced server-side when an action runs, not just hidden
            in this screen.
          </AlertDescription>
        </Alert>

        <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
          <div className="min-w-0 space-y-0.5">
            <label htmlFor={`${safeId}-auto-approve`} className="text-sm font-medium text-foreground">
              Auto-approve safe actions
            </label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Clears the approval step for actions the risk model classes as safe — meta
              descriptions, internal links, structured data, indexing submissions and content
              briefs. They still appear in History, and the always-approve list above still
              applies.
            </p>
          </div>
          <Switch
            id={`${safeId}-auto-approve`}
            checked={safe}
            disabled={pending !== null}
            onCheckedChange={(next) => void changeSafe(next)}
            aria-label="Auto-approve safe actions"
          />
        </div>

        {pending !== null ? (
          <p role="status" className="text-2xs text-muted-foreground">
            Saving…
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Exported for the settings screen, which shows the same ladder in a read-only summary. */
export function AutonomySummary({ autonomyLevel }: { autonomyLevel: string }): React.JSX.Element {
  const entry = AUTONOMY_DESCRIPTIONS[autonomyLevel as AutonomyKey] ?? null;
  if (!entry) return <Badge variant="muted">{autonomyLevel}</Badge>;

  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant="secondary">{entry.label}</Badge>
      <span className="text-xs text-muted-foreground">{entry.description}</span>
    </span>
  );
}
