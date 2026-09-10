'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Database, Loader2, Server, Sparkles, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Label } from '@/components/ui/label';
import { MetricCard } from '@/components/ui/metric-card';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { TimeSeriesChart } from '@/components/charts/time-series-chart';
import { apiPatch, apiPost, ApiError } from '@/lib/api-client';
import { formatCompact, formatNumber, formatUsd } from '@/lib/utils';
import { MODEL_ROLE_COPY, MODEL_ROLE_KEYS, type ModelRoleKey } from './types';
import type { GlobalSettings } from '@/server/queries/settings';

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  CONNECTED: 'success',
  ERROR: 'destructive',
  EXPIRED: 'warning',
  DISABLED: 'secondary',
  NOT_CONFIGURED: 'secondary',
};

export function GlobalSettingsView({ settings }: { settings: GlobalSettings }) {
  const router = useRouter();
  const { providers, defaults, budget, usage, integrations, environmentKeys, system } = settings;

  const [provider, setProvider] = useState<string>(defaults.provider ?? '');
  const [models, setModels] = useState<Record<ModelRoleKey, string>>({
    reasoning: defaults.models.reasoning ?? '',
    fast: defaults.models.fast ?? '',
    writing: defaults.models.writing ?? '',
    embedding: defaults.models.embedding ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  const anyConfigured = providers.some((p) => p.configured);
  const readOnly = system.readOnly || !system.canAdminister;

  const save = async () => {
    setSaving(true);
    try {
      await apiPatch('/api/settings', {
        provider: provider || null,
        reasoningModel: models.reasoning,
        fastModel: models.fast,
        writingModel: models.writing,
        embeddingModel: models.embedding,
      });
      toast.success('Defaults saved');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not save the defaults');
    } finally {
      setSaving(false);
    }
  };

  const cleanup = async () => {
    setCleaning(true);
    try {
      const result = await apiPost<{ deleted?: number }>('/api/settings/maintenance', { action: 'cleanup-jobs' });
      toast.success(
        typeof result.deleted === 'number'
          ? `Removed ${formatNumber(result.deleted)} old job record(s)`
          : 'Cleanup finished',
      );
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Cleanup failed');
    } finally {
      setCleaning(false);
    }
  };

  return (
    <Tabs defaultValue="ai">
      <TabsList>
        <TabsTrigger value="ai">AI providers</TabsTrigger>
        <TabsTrigger value="usage">AI usage</TabsTrigger>
        <TabsTrigger value="integrations">Integrations</TabsTrigger>
        <TabsTrigger value="system">System</TabsTrigger>
      </TabsList>

      {/* ── AI providers ─────────────────────────────────────── */}
      <TabsContent value="ai" className="mt-4 space-y-4">
        {!anyConfigured && (
          <Alert variant="warning" title="No AI provider is configured">
            Crawling, the technical audit, scoring, internal-link suggestions and GEO scoring all
            work without one. Agents, content generation, GEO recommendations and AI-visibility
            tracking need at least one key. Set any of the variables listed below and restart.
          </Alert>
        )}

        <div className="grid gap-3 md:grid-cols-3">
          {providers.map((entry) => (
            <Card key={entry.name}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center justify-between text-sm">
                  {entry.label}
                  <Badge variant={entry.configured ? 'success' : 'secondary'} className="text-2xs">
                    {entry.configured ? 'configured' : 'not configured'}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                {!entry.configured && (
                  <p className="text-muted-foreground">
                    Set <code className="rounded bg-muted px-1 py-0.5 font-mono">{entry.envVar}</code> to enable it.
                  </p>
                )}
                <p className="text-muted-foreground">
                  {entry.models.length} model{entry.models.length === 1 ? '' : 's'} ·{' '}
                  {entry.supportsEmbeddings ? 'supports embeddings' : 'no embedding model'}
                </p>
                {!entry.supportsEmbeddings && (
                  <p className="text-muted-foreground">
                    A capability gap, not a missing key — semantic features fall back to another
                    configured provider, or to lexical similarity.
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              Default model routing
              <TooltipInfo content="Each role resolves in this order: a per-site override, then the default chosen here, then the provider's built-in default. A site can always override any of these in its own settings." />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="default-provider">Default provider</Label>
              <select
                id="default-provider"
                value={provider}
                disabled={readOnly}
                onChange={(event) => setProvider(event.target.value)}
                className="h-9 w-full max-w-sm rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50"
              >
                <option value="">
                  Auto — first configured provider{defaults.envProvider ? ` (DEFAULT_AI_PROVIDER=${defaults.envProvider})` : ''}
                </option>
                {providers.map((entry) => (
                  <option key={entry.name} value={entry.name} disabled={!entry.configured}>
                    {entry.label}
                    {entry.configured ? '' : ' — key missing'}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Currently serving calls:{' '}
                <span className="font-medium text-foreground">{defaults.effectiveProvider ?? 'none'}</span>
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {MODEL_ROLE_KEYS.map((role) => {
                const resolved = settings.resolved[role];
                return (
                  <div key={role} className="space-y-1.5">
                    <Label htmlFor={`model-${role}`}>{MODEL_ROLE_COPY[role].label}</Label>
                    <input
                      id={`model-${role}`}
                      value={models[role]}
                      disabled={readOnly}
                      onChange={(event) => setModels((prev) => ({ ...prev, [role]: event.target.value }))}
                      placeholder={resolved.model ?? 'no provider available'}
                      spellCheck={false}
                      className="h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-xs disabled:opacity-50"
                    />
                    <p className="text-2xs text-muted-foreground">
                      {MODEL_ROLE_COPY[role].description} Resolves to{' '}
                      <span className="font-mono">{resolved.model ?? '—'}</span>
                      {resolved.provider ? ` on ${resolved.provider}` : ''}.
                    </p>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center gap-3">
              <Button onClick={() => void save()} disabled={saving || readOnly}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save defaults
              </Button>
              {readOnly && (
                <p className="text-xs text-muted-foreground">
                  {system.canAdminister
                    ? 'The installation is in read-only mode.'
                    : 'Only the owner or an admin can change installation defaults.'}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Monthly budget</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {budget.monthlyBudgetUsd === null ? (
              <p className="text-xs text-muted-foreground">
                No installation-wide cap. Set{' '}
                <code className="rounded bg-muted px-1 py-0.5 font-mono">{budget.envVar}</code> to bound total
                spend across every site. Per-site caps still apply and are set in each site&apos;s settings.
              </p>
            ) : (
              <>
                <ProgressBar
                  value={budget.percentUsed ?? 0}
                  max={100}
                  label={`${formatUsd(budget.spendThisMonthUsd)} of ${formatUsd(budget.monthlyBudgetUsd)} used this month`}
                />
                <p className="text-xs text-muted-foreground">
                  When the cap is reached, generation calls fail with AI_BUDGET_EXCEEDED rather than
                  continuing to spend. Change the cap through{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono">{budget.envVar}</code>.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* ── AI usage ─────────────────────────────────────────── */}
      <TabsContent value="usage" className="mt-4 space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard label="Spend today" value={formatUsd(usage.todayCostUsd)} icon={Sparkles}
            footer={`${formatNumber(usage.todayCalls)} call${usage.todayCalls === 1 ? '' : 's'}`} />
          <MetricCard label="Spend this month" value={formatUsd(usage.monthCostUsd)} icon={Sparkles}
            footer={`${formatNumber(usage.monthCalls)} call${usage.monthCalls === 1 ? '' : 's'}`} />
          <MetricCard label="Tokens this month" value={formatCompact(usage.monthTokensIn + usage.monthTokensOut)}
            footer={`${formatCompact(usage.monthTokensIn)} in · ${formatCompact(usage.monthTokensOut)} out`} />
          <MetricCard label="Failed calls" value={formatNumber(usage.monthFailures)}
            footer={usage.monthFailures === 0 ? 'No provider errors this month' : 'Check the worker logs'} />
        </div>

        {usage.monthCalls === 0 ? (
          <EmptyState
            bordered
            icon={Sparkles}
            title="No AI usage recorded yet"
            description={
              anyConfigured
                ? 'Run an agent, generate a content brief or a GEO audit and every call will be costed here by provider, model, task and site.'
                : 'Configure a provider key first — nothing can be spent until one is set.'
            }
          />
        ) : (
          <>
            <TimeSeriesChart
              title="Daily spend"
              description={`Last ${usage.trendDays} days`}
              data={usage.trend.map((point) => ({ date: point.date, cost: point.cost, calls: point.calls }))}
              series={[
                { key: 'cost', label: 'Cost (USD)', type: 'area' },
                { key: 'calls', label: 'Calls', axis: 'right' },
              ]}
              height={220}
            />

            <div className="grid gap-4 lg:grid-cols-2">
              <BreakdownCard title="By provider" rows={usage.byProvider} />
              <BreakdownCard title="By model" rows={usage.byModel} />
              <BreakdownCard title="By task" rows={usage.byTask} />
              <BreakdownCard title="By website" rows={usage.bySite} />
            </div>
          </>
        )}
      </TabsContent>

      {/* ── Integrations ─────────────────────────────────────── */}
      <TabsContent value="integrations" className="mt-4 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              Environment keys
              <TooltipInfo content="Whether each provider's credential is present in the environment. Values are never read back into the browser." />
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {environmentKeys.map((row) => (
                <li key={row.provider} className="flex items-start gap-3 px-4 py-2.5">
                  {row.status === 'NOT_CONFIGURED' ? (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{row.label}</p>
                    {row.detail && <p className="text-xs text-muted-foreground">{row.detail}</p>}
                    {row.requiredEnv.length > 0 && (
                      <p className="mt-0.5 font-mono text-2xs text-muted-foreground">
                        {row.requiredEnv.join(', ')}
                      </p>
                    )}
                  </div>
                  <Badge variant={STATUS_VARIANT[row.status] ?? 'secondary'} className="shrink-0 text-2xs">
                    {row.status.replace(/_/g, ' ').toLowerCase()}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Per-site connections</CardTitle>
          </CardHeader>
          <CardContent className={integrations.length === 0 ? '' : 'p-0'}>
            {integrations.length === 0 ? (
              <EmptyState
                size="sm"
                title="No site integrations connected"
                description="Open a website's Settings → Integrations to connect Search Console, a CMS adapter or Bing."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-4 py-2 font-medium">Website</th>
                      <th scope="col" className="px-3 py-2 font-medium">Provider</th>
                      <th scope="col" className="px-3 py-2 font-medium">Status</th>
                      <th scope="col" className="px-3 py-2 font-medium">Account</th>
                      <th scope="col" className="px-3 py-2 font-medium">Last sync</th>
                    </tr>
                  </thead>
                  <tbody>
                    {integrations.map((row) => (
                      <tr key={`${row.websiteId}-${row.provider}`} className="data-grid-row">
                        <td className="px-4 py-2">
                          <Link href={`/sites/${row.websiteId}/settings`} className="hover:text-primary">
                            {row.websiteName}
                          </Link>
                        </td>
                        <td className="px-3 py-2">{row.label}</td>
                        <td className="px-3 py-2">
                          <Badge variant={STATUS_VARIANT[row.status] ?? 'secondary'} className="text-2xs">
                            {row.status.replace(/_/g, ' ').toLowerCase()}
                          </Badge>
                          {row.lastError && (
                            <p className="mt-0.5 max-w-[280px] truncate text-2xs text-destructive" title={row.lastError}>
                              {row.lastError}
                            </p>
                          )}
                          {!row.envReady && (
                            <p className="mt-0.5 font-mono text-2xs text-muted-foreground">
                              needs {row.requiredEnv.join(', ')}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{row.accountEmail ?? '—'}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {row.lastSyncAt
                            ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short' }).format(
                                new Date(row.lastSyncAt),
                              )
                            : 'never'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* ── System ───────────────────────────────────────────── */}
      <TabsContent value="system" className="mt-4 space-y-4">
        {!system.redisOk && (
          <Alert variant="warning" title="No job broker connected">
            {system.redisConfigured
              ? `REDIS_URL is set but the connection is ${system.redisStatus}${system.redisError ? ` (${system.redisError})` : ''}. Jobs will be recorded and stay queued until a broker and worker are available.`
              : 'REDIS_URL is not set. Crawls, syncs and agent runs are recorded in the database but nothing will execute until Redis is configured and the worker is running.'}
          </Alert>
        )}

        {system.demoMode && (
          <Alert variant="info" title="Demo mode is on">
            DEMO_MODE=true. Seeded demo websites are marked <code className="font-mono">isDemo</code> and prefixed
            &quot;[DEMO]&quot;. Set it to false for real sites, and remove the demo rows with{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">npm run db:seed -- --clear-demo</code>.
          </Alert>
        )}

        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Database"
            value={system.databaseOk ? 'Connected' : 'Unreachable'}
            icon={Database}
            footer={system.databaseError ?? 'PostgreSQL'}
          />
          <MetricCard
            label="Job broker"
            value={system.redisOk ? 'Ready' : system.redisConfigured ? system.redisStatus : 'Not configured'}
            icon={Server}
            footer={`${formatNumber(system.queuedJobs)} job(s) waiting`}
          />
          <MetricCard
            label="Scheduler"
            value={system.schedulerEnabled ? 'Enabled' : 'Disabled'}
            footer={`Worker concurrency ${system.workerConcurrency}`}
          />
          <MetricCard
            label="JS rendering"
            value={system.jsRenderingEnabled ? 'Enabled' : 'Disabled'}
            footer={system.jsRenderingEnabled ? 'Playwright will render pages' : 'HTTP crawling only — faster'}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Job history</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">Records stored</dt>
                <dd className="tabular font-semibold">{formatNumber(system.jobHistoryCount)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Older than {system.retentionDays} days</dt>
                <dd className="tabular font-semibold">{formatNumber(system.prunableJobs)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Last job started</dt>
                <dd className="text-sm">
                  {system.lastJobStartedAt
                    ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short' }).format(
                        new Date(system.lastJobStartedAt),
                      )
                    : 'never'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Version</dt>
                <dd className="text-sm">
                  {system.appVersion} · {system.environment}
                </dd>
              </div>
            </dl>

            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void cleanup()}
                disabled={cleaning || !system.canAdminister || system.prunableJobs === 0}
              >
                {cleaning ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <AlertTriangle className="mr-1.5 h-3.5 w-3.5" />}
                Remove {formatNumber(system.prunableJobs)} old job record(s)
              </Button>
              <Link href="/jobs" className="text-xs font-medium text-primary hover:underline">
                Open the Jobs screen
              </Link>
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}

function BreakdownCard({
  title,
  rows,
}: {
  title: string;
  rows: GlobalSettings['usage']['byProvider'];
}) {
  const total = rows.reduce((sum, row) => sum + row.costUsd, 0);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No usage recorded.</p>
        ) : (
          <ul className="space-y-2">
            {rows.slice(0, 8).map((row) => (
              <li key={row.key} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate font-medium" title={row.label}>{row.label}</span>
                  <span className="tabular shrink-0 text-muted-foreground">
                    {formatUsd(row.costUsd)} · {formatNumber(row.calls)} calls
                  </span>
                </div>
                <ProgressBar value={total > 0 ? (row.costUsd / total) * 100 : 0} max={100} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
