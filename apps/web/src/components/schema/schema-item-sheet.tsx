'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, Rocket, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { StatList, StatListItem } from '@/components/ui/stat-list';
import { Switch } from '@/components/ui/switch';
import { ApiError, apiDelete, apiPost } from '@/lib/api-client';
import { shortenUrl } from '@/lib/utils';
import { IssueList, JsonLdBlock, ScriptTagBlock, ValidationBadge } from './json-ld-block';
import {
  countErrors,
  toIssues,
  type DeleteResponse,
  type DeployResponse,
  type StructuredDataItemDto,
  type ValidateResponse,
} from './types';

const DATE_TIME = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

type Pending = 'validate' | 'deploy' | 'delete' | null;

export interface SchemaItemSheetProps {
  item: StructuredDataItemDto | null;
  websiteId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after any mutation so the list refetches. */
  onChanged: () => void;
  /** A connected adapter can write the tag into the live page. */
  canDeploy: boolean;
  adapterLabel: string | null;
}

export function SchemaItemSheet({
  item,
  websiteId,
  open,
  onOpenChange,
  onChanged,
  canDeploy,
  adapterLabel,
}: SchemaItemSheetProps): React.JSX.Element {
  const [pending, setPending] = useState<Pending>(null);
  const [externalId, setExternalId] = useState('');
  const [allowWarnings, setAllowWarnings] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** The verdict from a validate run in this session, which is fresher than the stored row. */
  const [freshValidation, setFreshValidation] = useState<ValidateResponse | null>(null);

  // Each row opens with its own state, never the previous row's typed CMS id.
  useEffect(() => {
    setPending(null);
    setExternalId('');
    setAllowWarnings(false);
    setFreshValidation(null);
  }, [item]);

  const storedIssues = item ? toIssues(item.validationErrors) : [];
  const issues = freshValidation?.issues ?? storedIssues;
  const status = freshValidation?.status ?? item?.validationStatus ?? 'UNVALIDATED';
  const errorCount = countErrors(issues);
  const hasMarkup = item?.jsonLd !== null && item?.jsonLd !== undefined;

  async function validate(): Promise<void> {
    if (!item) return;
    setPending('validate');
    try {
      const result = await apiPost<ValidateResponse>('/api/schema/validate', {
        jsonLd: item.jsonLd,
        itemId: item.id,
        websiteId,
      });
      setFreshValidation(result);
      if (result.status === 'VALID') toast.success('Markup is valid');
      else if (result.status === 'WARNING') toast.warning(`${result.issues.length} recommendation(s) to address`);
      else toast.error(`${countErrors(result.issues)} error(s) block rich results`);
      onChanged();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'The markup could not be validated.');
    } finally {
      setPending(null);
    }
  }

  async function deploy(): Promise<void> {
    if (!item) return;
    setPending('deploy');
    try {
      const result = await apiPost<DeployResponse>(`/api/schema/${item.id}/deploy`, {
        ...(externalId.trim().length > 0 ? { externalId: externalId.trim() } : {}),
        ...(allowWarnings ? { allowWarnings: true } : {}),
      });
      if (result.status === 'skipped') {
        toast.warning(result.reason ?? 'Nothing was deployed.', { description: result.fix });
        return;
      }
      if (result.job && result.job.enqueued === false) {
        toast.warning('Queued in the database, but no worker picked it up', { description: result.job.message });
      } else {
        toast.success('Deployment queued', {
          description: `${adapterLabel ?? 'The connected CMS'} will receive the tag; watch the action on the Jobs screen.`,
        });
      }
      onChanged();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'The deployment could not be queued.');
    } finally {
      setPending(null);
    }
  }

  async function remove(): Promise<void> {
    if (!item) return;
    setPending('delete');
    try {
      const result = await apiDelete<DeleteResponse>(`/api/schema/${item.id}`);
      if (result.warning) {
        toast.warning('Record deleted, but the page still carries the tag', { description: result.warning });
      } else {
        toast.success(`${result.schemaType} markup deleted`);
      }
      onChanged();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'The item could not be deleted.');
      throw error;
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-xl">
          {item === null ? null : (
            <>
              <SheetHeader>
                <SheetTitle>{item.schemaType}</SheetTitle>
                <SheetDescription>
                  {item.page ? (
                    <>
                      Markup for{' '}
                      <span className="font-medium text-foreground">{shortenUrl(item.page.url, 44)}</span>.
                    </>
                  ) : (
                    'Site-wide markup — not attached to a single page.'
                  )}
                </SheetDescription>
              </SheetHeader>

              <SheetBody className="space-y-5 py-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <ValidationBadge status={status} errorCount={errorCount} />
                  <StatusBadge status={item.deploymentStatus} />
                  <Badge variant="muted">{item.source === 'generated' ? 'Generated' : item.source}</Badge>
                  {item.page ? (
                    <a
                      href={item.page.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      Open page
                      <ExternalLink className="size-3" aria-hidden="true" />
                    </a>
                  ) : null}
                </div>

                <section className="space-y-2" aria-labelledby="schema-validation-heading">
                  <h3 id="schema-validation-heading" className="text-xs font-semibold text-foreground">
                    Validation
                    {freshValidation ? (
                      <span className="ml-2 font-normal text-muted-foreground">just re-checked</span>
                    ) : null}
                  </h3>
                  <IssueList
                    issues={issues}
                    emptyMessage={
                      status === 'UNVALIDATED'
                        ? 'This block has not been validated yet — run “Validate” to check it.'
                        : 'Every required and recommended property is present.'
                    }
                  />
                </section>

                <JsonLdBlock jsonLd={item.jsonLd} />

                <ScriptTagBlock jsonLd={item.jsonLd} />

                <StatList divided dense>
                  <StatListItem label="Schema type" value={item.schemaType} mono />
                  <StatListItem
                    label="Page type"
                    value={item.page?.pageType ?? 'Site-wide'}
                    mono
                  />
                  <StatListItem label="Source" value={item.source} mono />
                  <StatListItem
                    label="Deployed"
                    value={item.deployedAt ? DATE_TIME.format(new Date(item.deployedAt)) : 'Never'}
                    muted={item.deployedAt === null}
                  />
                  <StatListItem label="Updated" value={DATE_TIME.format(new Date(item.updatedAt))} />
                  <StatListItem label="Item id" value={item.id} mono copyValue={item.id} />
                  {item.notes ? <StatListItem label="Notes" value={item.notes} /> : null}
                </StatList>

                <section className="space-y-3" aria-labelledby="schema-deploy-heading">
                  <h3 id="schema-deploy-heading" className="text-xs font-semibold text-foreground">
                    Deployment
                  </h3>

                  {canDeploy ? (
                    <>
                      <FormField
                        label="CMS content id"
                        description={
                          'The post, page or item id in ' +
                          `${adapterLabel ?? 'your CMS'}. Leave blank to reuse the id from a draft already published to this page; ` +
                          'without either, the adapter has no address to write to and the deploy is refused.'
                        }
                      >
                        <Input
                          value={externalId}
                          onChange={(event) => setExternalId(event.target.value)}
                          placeholder="e.g. 1423"
                          autoComplete="off"
                        />
                      </FormField>

                      {status === 'WARNING' ? (
                        <div className="flex items-start gap-2">
                          <Switch
                            id="schema-allow-warnings"
                            checked={allowWarnings}
                            onCheckedChange={setAllowWarnings}
                          />
                          <Label htmlFor="schema-allow-warnings" className="text-xs font-normal text-muted-foreground">
                            Deploy despite {issues.length} warning{issues.length === 1 ? '' : 's'}. Warnings mean the
                            markup is eligible but incomplete; errors can never be overridden.
                          </Label>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <Alert variant="neutral">
                      <AlertTitle>No CMS adapter can inject structured data</AlertTitle>
                      <AlertDescription>
                        Copy the <code className="font-mono">&lt;script&gt;</code> tag above into the page template
                        yourself, or connect an adapter that supports structured data under Settings →
                        Integrations to have it written for you.
                      </AlertDescription>
                    </Alert>
                  )}

                  {errorCount > 0 ? (
                    <Alert variant="destructive">
                      <AlertTitle>Deployment is blocked while the markup is invalid</AlertTitle>
                      <AlertDescription>
                        Shipping structured data that search engines reject is worse than shipping none. Fix the{' '}
                        {errorCount} error{errorCount === 1 ? '' : 's'} above, then re-validate.
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </section>
              </SheetBody>

              <SheetFooter>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDelete(true)}
                  disabled={pending !== null}
                  className="sm:mr-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  Delete
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void validate()}
                  loading={pending === 'validate'}
                  loadingText="Validating"
                  disabled={pending !== null || !hasMarkup}
                >
                  <ShieldCheck className="size-3.5" aria-hidden="true" />
                  Validate
                </Button>
                <Button
                  size="sm"
                  onClick={() => void deploy()}
                  loading={pending === 'deploy'}
                  loadingText="Queueing"
                  disabled={
                    pending !== null ||
                    !canDeploy ||
                    errorCount > 0 ||
                    item.deploymentStatus === 'PENDING' ||
                    !hasMarkup
                  }
                >
                  <Rocket className="size-3.5" aria-hidden="true" />
                  {item.deploymentStatus === 'PENDING' ? 'Deployment queued' : 'Deploy'}
                </Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this structured data record?"
        description={
          item?.deploymentStatus === 'DEPLOYED'
            ? 'This block is already live. Deleting removes our record only — the <script> tag stays on the page until you take it off yourself.'
            : 'The generated markup is removed from this workspace. Generating again will re-derive it from the page content.'
        }
        confirmLabel="Delete"
        destructive
        onConfirm={remove}
      />
    </>
  );
}
