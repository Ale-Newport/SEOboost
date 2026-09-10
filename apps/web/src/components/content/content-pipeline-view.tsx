'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  FileText,
  PenLine,
  Rocket,
  Sparkles,
  Target,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/ui/empty-state';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { DataTable, type ColumnDef } from '@/components/data/data-table';
import { EnumFilter, FacetFilter, FilterBar, humanizeFilterValue, useFilterPills, type FilterLabelConfig } from '@/components/data/filter-bar';
import { useTableParams } from '@/components/data/use-table-params';
import { ScoreCell } from '@/components/data/score-cell';
import { ApiError, apiPost } from '@/lib/api-client';
import { cn, formatNumber, shortenUrl } from '@/lib/utils';

import { STAGE_META, stageIndex, stageMeta } from './meta';
import {
  CONTENT_STAGE_STATUSES,
  PIPELINE_STAGES,
  TERMINAL_STAGES,
  type BriefRow,
  type ContentStageValue,
  type DraftRow,
  type StageCount,
} from './types';

/**
 * The content pipeline for one site.
 *
 * Two lists, one funnel: briefs are the plan, drafts are the work, and the stage strip above
 * both is the only place that says how far each draft has actually got. Filters, search, the
 * page and the open tab are URL state, so the server query beside this component sees exactly
 * what the operator is looking at.
 */

export interface ContentPipelineViewProps {
  website: { id: string; name: string; domain: string };
  drafts: DraftRow[];
  draftTotal: number;
  draftPage: number;
  draftPageSize: number;
  briefs: BriefRow[];
  briefTotal: number;
  stageCounts: StageCount[];
}

const FILTER_LABELS: Readonly<Record<string, FilterLabelConfig>> = {
  stage: { label: 'Stage', formatValue: (value) => stageMeta(value).label },
  stageStatus: { label: 'Stage status', formatValue: humanizeFilterValue },
};

const PHASES = ['Research', 'Plan', 'Write', 'Verify', 'Ship'] as const;
type Phase = (typeof PHASES)[number];

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });

function formatDate(iso: string | null): string {
  if (iso === null) return '—';
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? '—' : DATE_FORMAT.format(parsed);
}

const TOTAL_PIPELINE_STAGES = PIPELINE_STAGES.length;

/** Progress through the 14 working stages. Terminal states are an outcome, not a position. */
function StageCellContent({ draft }: { draft: DraftRow }): React.JSX.Element {
  const meta = stageMeta(draft.stage);
  const Icon = meta.icon;
  const index = stageIndex(draft.stage);

  return (
    <div className="min-w-0 space-y-0.5">
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <SimpleTooltip content={meta.description}>
          <span className="truncate text-xs font-medium text-foreground">{meta.label}</span>
        </SimpleTooltip>
        <StatusBadge status={draft.stageStatus} />
      </div>
      <span className="text-2xs text-muted-foreground">
        {index === null ? meta.phase : `Stage ${index + 1} of ${TOTAL_PIPELINE_STAGES} · ${meta.phase}`}
      </span>
    </div>
  );
}

interface StageStripProps {
  counts: ReadonlyMap<string, number>;
  selected: readonly string[];
  onToggle: (stage: ContentStageValue) => void;
}

/**
 * Every stage with its real draft count, as a filter.
 *
 * Stages with no drafts are still shown: the shape of the pipeline is the point, and hiding the
 * empty stages would make a pipeline stuck at FACT_CHECK look like a pipeline that ends there.
 */
function StageStrip({ counts, selected, onToggle }: StageStripProps): React.JSX.Element {
  const byPhase = useMemo(() => {
    const groups = new Map<Phase, ContentStageValue[]>();
    for (const phase of PHASES) groups.set(phase, []);
    for (const stage of [...PIPELINE_STAGES, ...TERMINAL_STAGES] as ContentStageValue[]) {
      groups.get(STAGE_META[stage].phase)?.push(stage);
    }
    return groups;
  }, []);

  return (
    <section className="rounded-lg border border-border bg-card p-3" aria-label="Drafts by stage">
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        {PHASES.map((phase) => {
          const stages = byPhase.get(phase) ?? [];
          const phaseTotal = stages.reduce((sum, stage) => sum + (counts.get(stage) ?? 0), 0);
          return (
            <div key={phase} className="min-w-0 space-y-1.5">
              <h3 className="flex items-baseline gap-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                {phase}
                <span className="tabular font-normal">{formatNumber(phaseTotal)}</span>
              </h3>
              <ul className="flex flex-wrap gap-1">
                {stages.map((stage) => {
                  const count = counts.get(stage) ?? 0;
                  const active = selected.includes(stage);
                  const meta = STAGE_META[stage];
                  return (
                    <li key={stage}>
                      <SimpleTooltip content={meta.description}>
                        <button
                          type="button"
                          aria-pressed={active}
                          onClick={() => onToggle(stage)}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-2xs transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                            active
                              ? 'border-primary bg-primary/10 text-foreground'
                              : count > 0
                                ? 'border-border bg-background text-foreground hover:bg-accent'
                                : 'border-dashed border-border bg-background text-muted-foreground hover:bg-accent',
                          )}
                        >
                          <span className="truncate">{meta.label}</span>
                          <span className="tabular font-medium">{formatNumber(count)}</span>
                        </button>
                      </SimpleTooltip>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function ContentPipelineView({
  website,
  drafts,
  draftTotal,
  draftPage,
  draftPageSize,
  briefs,
  briefTotal,
  stageCounts,
}: ContentPipelineViewProps): React.JSX.Element {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const table = useTableParams({ defaultPageSize: draftPageSize, defaultSort: null });
  const { getParam, getParamList, setParams, setFilters, setPage, setSearch, clearFilters, toggleFilterValue } = table;
  const pills = useFilterPills(FILTER_LABELS);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [writerRunning, setWriterRunning] = useState(false);

  const tab = getParam('tab') === 'briefs' ? 'briefs' : 'drafts';
  const selectedStages = getParamList('stage');

  const counts = useMemo(
    () => new Map<string, number>(stageCounts.map((entry) => [entry.stage, entry.count])),
    [stageCounts],
  );

  const totals = useMemo(() => {
    let all = 0;
    let published = 0;
    let awaiting = 0;
    let terminal = 0;
    for (const entry of stageCounts) {
      all += entry.count;
      if (entry.stage === 'PUBLISHED') published += entry.count;
      if (entry.stage === 'READY_FOR_APPROVAL') awaiting += entry.count;
      if ((TERMINAL_STAGES as readonly string[]).includes(entry.stage)) terminal += entry.count;
    }
    return { all, published, awaiting, inFlight: all - terminal };
  }, [stageCounts]);

  const approve = useCallback(
    async (draft: DraftRow) => {
      const ok = await confirm({
        title: `Approve “${draft.title}”?`,
        description:
          draft.unverifiedClaimCount > 0
            ? `The fact-check stage could not verify ${draft.unverifiedClaimCount} claim${draft.unverifiedClaimCount === 1 ? '' : 's'} in this draft. Approving now records that you accepted them as they stand.`
            : 'The exact text you are approving is stored as a version, so what was signed off stays recoverable.',
        confirmLabel: 'Approve',
      });
      if (!ok) return;

      setBusyId(draft.id);
      try {
        await apiPost(`/api/content/drafts/${draft.id}/approve`, {
          ...(draft.unverifiedClaimCount > 0 ? { acknowledgeUnverified: true } : {}),
        });
        toast.success('Draft approved', { description: 'It is queued for the CMS adapter.' });
        router.refresh();
      } catch (error) {
        toast.error(error instanceof ApiError ? error.message : 'Could not approve the draft');
      } finally {
        setBusyId(null);
      }
    },
    [confirm, router],
  );

  const publish = useCallback(
    async (draft: DraftRow) => {
      const ok = await confirm({
        title: `Publish “${draft.title}” to the live site?`,
        description:
          'This hands the draft to the CMS adapter configured for this website. It writes to the live site — the version history is what makes it reversible.',
        confirmLabel: 'Publish',
      });
      if (!ok) return;

      setBusyId(draft.id);
      try {
        await apiPost(`/api/content/drafts/${draft.id}/publish`, {});
        toast.success('Publishing started', { description: 'The page appears here with its live URL once the adapter confirms.' });
        router.refresh();
      } catch (error) {
        toast.error(error instanceof ApiError ? error.message : 'Could not publish the draft');
      } finally {
        setBusyId(null);
      }
    },
    [confirm, router],
  );

  const startDraft = useCallback(
    async (brief: BriefRow) => {
      setBusyId(brief.id);
      try {
        await apiPost('/api/content/drafts', {
          websiteId: website.id,
          briefId: brief.id,
          title: brief.title,
          kind: 'NEW',
          ...(brief.targetKeyword ? { targetKeyword: brief.targetKeyword } : {}),
          ...(brief.suggestedUrl ? { slug: brief.suggestedUrl.replace(/^\/+/, '').slice(0, 200) } : {}),
        });
        toast.success('Draft created', {
          description: 'It enters the pipeline at the first stage. Run the content writer to work it through.',
        });
        setParams({ tab: null });
        router.refresh();
      } catch (error) {
        toast.error(error instanceof ApiError ? error.message : 'Could not create the draft');
      } finally {
        setBusyId(null);
      }
    },
    [router, setParams, website.id],
  );

  const runWriter = useCallback(async () => {
    if (totals.inFlight === 0) {
      toast.info('Nothing for the writer to work on', {
        description:
          'Every draft on this site is already approved, published or rejected. Start a draft from a brief first.',
      });
      return;
    }
    setWriterRunning(true);
    try {
      const result = await apiPost<{ job?: { enqueued: boolean; message: string }; status?: string; reason?: string; fix?: string }>(
        '/api/agents/content-writer/run',
        { websiteId: website.id },
      );
      if (result.status === 'skipped') {
        toast.warning('The writer did not run', { description: result.fix ?? result.reason ?? 'Nothing to work on.' });
      } else if (result.job && !result.job.enqueued) {
        toast.warning('Queued, but no worker picked it up', { description: result.job.message });
      } else {
        toast.success('Content writer is running', {
          description:
            'It works the drafts in this pipeline through their remaining stages. Anything it cannot source is left as an explicit [VERIFY] marker rather than invented.',
        });
      }
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not start the agent');
    } finally {
      setWriterRunning(false);
    }
  }, [router, totals.inFlight, website.id]);

  const draftColumns = useMemo<Array<ColumnDef<DraftRow>>>(
    () => [
      {
        id: 'title',
        header: 'Draft',
        accessor: (row) => row.title,
        sticky: true,
        width: 300,
        cell: (row) => (
          <div className="min-w-0 space-y-0.5">
            <p className="truncate text-sm font-medium text-foreground" title={row.title}>
              {row.title}
            </p>
            <p className="truncate text-2xs text-muted-foreground">
              {row.targetKeyword ?? 'No target keyword'}
              {row.slug === null ? '' : ` · /${row.slug.replace(/^\/+/, '')}`}
            </p>
          </div>
        ),
      },
      {
        id: 'stage',
        header: 'Stage',
        accessor: (row) => row.stage,
        width: 210,
        exportValue: (row) => stageMeta(row.stage).label,
        cell: (row) => <StageCellContent draft={row} />,
      },
      {
        id: 'qualityScore',
        header: (
          <span className="inline-flex items-center gap-1">
            Quality
            <TooltipInfo content="0–100 from the QUALITY_REVIEW stage: thin sections, keyword stuffing, AI tells and unresolved [VERIFY] markers. Blank until that stage has run on this draft." />
          </span>
        ),
        headerLabel: 'Quality',
        accessor: (row) => row.qualityScore,
        align: 'right',
        width: 110,
        cell: (row) => <ScoreCell value={row.qualityScore} label="Quality score" />,
      },
      {
        id: 'seoScore',
        header: (
          <span className="inline-flex items-center gap-1">
            SEO
            <TooltipInfo content="0–100 from the SEO_OPTIMISATION stage: title and meta lengths, heading structure, keyword coverage and over-optimisation. Blank until that stage has run." />
          </span>
        ),
        headerLabel: 'SEO',
        accessor: (row) => row.seoScore,
        align: 'right',
        width: 100,
        cell: (row) => <ScoreCell value={row.seoScore} label="SEO score" />,
      },
      {
        id: 'geoScore',
        header: (
          <span className="inline-flex items-center gap-1">
            GEO
            <TooltipInfo content="0–100 generative-engine readiness: entity clarity, fact density, structure and citation-worthiness. Blank until the GEO pass has scored this draft." />
          </span>
        ),
        headerLabel: 'GEO',
        accessor: (row) => row.geoScore,
        align: 'right',
        width: 100,
        defaultHidden: true,
        cell: (row) => <ScoreCell value={row.geoScore} label="GEO score" />,
      },
      {
        id: 'readabilityScore',
        header: (
          <span className="inline-flex items-center gap-1">
            Readability
            <TooltipInfo content="Flesch reading ease over the draft body: 0–100, higher is easier. 60–70 is plain English. Blank until the draft has body text to measure." />
          </span>
        ),
        headerLabel: 'Readability',
        accessor: (row) => row.readabilityScore,
        align: 'right',
        width: 120,
        defaultHidden: true,
        cell: (row) => <ScoreCell value={row.readabilityScore} label="Readability score" />,
      },
      {
        id: 'wordCount',
        header: 'Words',
        accessor: (row) => row.wordCount,
        align: 'right',
        width: 84,
        cell: (row) => <span className="tabular text-sm text-muted-foreground">{formatNumber(row.wordCount)}</span>,
      },
      {
        id: 'risks',
        header: 'Blockers',
        accessor: (row) => row.blockingFlagCount + row.unverifiedClaimCount,
        width: 170,
        exportValue: (row) => `${row.blockingFlagCount} blocking, ${row.unverifiedClaimCount} unverified`,
        cell: (row) =>
          row.blockingFlagCount === 0 && row.unverifiedClaimCount === 0 ? (
            <span className="text-2xs text-muted-foreground">None recorded</span>
          ) : (
            <span className="flex flex-wrap items-center gap-1">
              {row.blockingFlagCount > 0 ? (
                <SimpleTooltip content="Quality flags marked BLOCKING. The draft should not be approved while these stand.">
                  <Badge variant="destructive">{formatNumber(row.blockingFlagCount)} blocking</Badge>
                </SimpleTooltip>
              ) : null}
              {row.unverifiedClaimCount > 0 ? (
                <SimpleTooltip content="Claims the fact-check stage could not support from the brand facts or the cited sources.">
                  <Badge variant="warning">{formatNumber(row.unverifiedClaimCount)} unverified</Badge>
                </SimpleTooltip>
              ) : null}
            </span>
          ),
      },
      {
        id: 'updatedAt',
        header: 'Updated',
        accessor: (row) => row.updatedAt,
        width: 120,
        exportValue: (row) => row.updatedAt,
        cell: (row) => (
          <span className="text-2xs text-muted-foreground">
            {formatDate(row.updatedAt)}
            {row.scheduledFor === null ? '' : ` · for ${formatDate(row.scheduledFor)}`}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '',
        headerLabel: 'Actions',
        accessor: () => '',
        width: 150,
        exportValue: () => null,
        cell: (row) => (
          <span className="flex items-center justify-end gap-1.5">
            {row.publishedUrl ? (
              <a
                href={row.publishedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-2xs font-medium text-primary hover:underline"
              >
                {shortenUrl(row.publishedUrl, 24)}
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            ) : null}
            {row.stage === 'READY_FOR_APPROVAL' ? (
              <Button size="sm" variant="outline" loading={busyId === row.id} onClick={() => void approve(row)}>
                Approve
              </Button>
            ) : null}
            {row.stage === 'APPROVED' ? (
              <Button size="sm" loading={busyId === row.id} onClick={() => void publish(row)}>
                Publish
              </Button>
            ) : null}
          </span>
        ),
      },
    ],
    [approve, busyId, publish],
  );

  const briefColumns = useMemo<Array<ColumnDef<BriefRow>>>(
    () => [
      {
        id: 'title',
        header: 'Brief',
        accessor: (row) => row.title,
        sortable: true,
        sticky: true,
        width: 300,
        cell: (row) => (
          <div className="min-w-0 space-y-0.5">
            <p className="truncate text-sm font-medium text-foreground" title={row.title}>
              {row.title}
            </p>
            <p className="truncate text-2xs text-muted-foreground">
              {row.targetKeyword}
              {row.secondaryKeywords.length > 0 ? ` +${formatNumber(row.secondaryKeywords.length)} secondary` : ''}
            </p>
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        accessor: (row) => row.status,
        sortable: true,
        width: 120,
        cell: (row) => <StatusBadge status={row.status} />,
      },
      {
        id: 'intent',
        header: 'Intent',
        accessor: (row) => row.intent,
        sortable: true,
        width: 140,
        cell: (row) => (
          <span className="text-2xs text-muted-foreground">
            {humanizeFilterValue(row.intent)} · {humanizeFilterValue(row.funnelStage)}
          </span>
        ),
      },
      {
        id: 'outlineLength',
        header: 'Outline',
        accessor: (row) => row.outlineLength,
        sortable: true,
        align: 'right',
        width: 100,
        cell: (row) =>
          row.outlineLength === 0 ? (
            <SimpleTooltip content="No outline yet. The BRIEF pipeline stage fills it in from the SERP snapshot and the brand knowledge base.">
              <span className="text-2xs text-muted-foreground">Not built</span>
            </SimpleTooltip>
          ) : (
            <span className="tabular text-sm">{formatNumber(row.outlineLength)}</span>
          ),
      },
      {
        id: 'questionCount',
        header: 'Questions',
        accessor: (row) => row.questionCount,
        sortable: true,
        align: 'right',
        width: 104,
        cell: (row) => <span className="tabular text-sm text-muted-foreground">{formatNumber(row.questionCount)}</span>,
      },
      {
        id: 'targetWordCount',
        header: 'Target words',
        accessor: (row) => row.targetWordCount,
        sortable: true,
        align: 'right',
        width: 116,
        cell: (row) => (
          <span className="tabular text-sm text-muted-foreground">
            {row.targetWordCount === null ? '—' : formatNumber(row.targetWordCount)}
          </span>
        ),
      },
      {
        id: 'draftCount',
        header: 'Drafts',
        accessor: (row) => row.draftCount,
        sortable: true,
        align: 'right',
        width: 84,
        cell: (row) => <span className="tabular text-sm">{formatNumber(row.draftCount)}</span>,
      },
      {
        id: 'createdAt',
        header: 'Created',
        accessor: (row) => row.createdAt,
        sortable: true,
        width: 110,
        cell: (row) => <span className="text-2xs text-muted-foreground">{formatDate(row.createdAt)}</span>,
      },
      {
        id: 'actions',
        header: '',
        headerLabel: 'Actions',
        accessor: () => '',
        width: 130,
        exportValue: () => null,
        cell: (row) => (
          <span className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              loading={busyId === row.id}
              onClick={() => void startDraft(row)}
            >
              <PenLine aria-hidden="true" />
              Start a draft
            </Button>
          </span>
        ),
      },
    ],
    [busyId, startDraft],
  );

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Content pipeline"
        description={`Briefs and drafts for ${website.name}. Nothing reaches ${website.domain} without a human approval.`}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`/sites/${website.id}/opportunities`}>
                <Target aria-hidden="true" />
                Opportunities
              </Link>
            </Button>
            <Button
              size="sm"
              onClick={() => void runWriter()}
              loading={writerRunning}
              loadingText="Starting"
            >
              <Sparkles aria-hidden="true" />
              Run the writer
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Drafts"
          value={formatNumber(totals.all)}
          icon={FileText}
          footer={`${formatNumber(totals.inFlight)} still moving through the pipeline`}
        />
        <MetricCard
          label="Awaiting approval"
          value={formatNumber(totals.awaiting)}
          icon={CheckCircle2}
          info="Drafts that have completed all 14 stages and need a person to sign them off. Nothing publishes without this step."
          footer={totals.awaiting === 0 ? 'Nothing waiting on you' : 'Needs a decision'}
        />
        <MetricCard
          label="Published"
          value={formatNumber(totals.published)}
          icon={Rocket}
          footer="Live on the site"
        />
        <MetricCard
          label="Briefs"
          value={formatNumber(briefTotal)}
          icon={ClipboardList}
          info="A brief is the plan for one page: angle, target keyword, questions to answer and the outline. Drafts are always started from one."
          footer={briefTotal === 0 ? 'None created yet' : 'Ready to draft from'}
        />
      </div>

      <StageStrip
        counts={counts}
        selected={selectedStages}
        onToggle={(stage) => toggleFilterValue('stage', stage)}
      />

      <Tabs value={tab} onValueChange={(next) => setFilters({ tab: next === 'drafts' ? null : next })}>
        <TabsList>
          <TabsTrigger value="drafts">
            <FileText aria-hidden="true" />
            Drafts
            <span className="tabular text-muted-foreground">{formatNumber(totals.all)}</span>
          </TabsTrigger>
          <TabsTrigger value="briefs">
            <ClipboardList aria-hidden="true" />
            Briefs
            <span className="tabular text-muted-foreground">{formatNumber(briefTotal)}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="drafts" className="pt-4">
          <DataTable<DraftRow>
            data={drafts}
            columns={draftColumns}
            getRowId={(row) => row.id}
            caption="Content drafts for this website, with the pipeline stage each one has reached"
            searchable
            manualSearch
            search={table.searchInput}
            onSearchChange={setSearch}
            searchPlaceholder="Search draft titles and keywords…"
            page={draftPage}
            pageSize={draftPageSize}
            total={draftTotal}
            onPageChange={setPage}
            itemLabel="drafts"
            filterPills={pills}
            onClearFilters={clearFilters}
            exportable={false}
            stickyHeader
            maxHeight="calc(100vh - 26rem)"
            toolbar={
              <FilterBar>
                <FacetFilter
                  paramKey="stage"
                  label="Stage"
                  icon={PenLine}
                  searchable
                  options={[...PIPELINE_STAGES, ...TERMINAL_STAGES].map((stage) => ({
                    value: stage,
                    label: STAGE_META[stage].label,
                    icon: STAGE_META[stage].icon,
                    count: counts.get(stage) ?? 0,
                  }))}
                />
                <FacetFilter
                  paramKey="stageStatus"
                  label="Stage status"
                  options={CONTENT_STAGE_STATUSES.map((status) => ({
                    value: status,
                    label: humanizeFilterValue(status),
                  }))}
                />
                <EnumFilter
                  paramKey="order"
                  label="Order"
                  allLabel="Newest first"
                  options={[
                    { value: 'desc', label: 'Newest first' },
                    { value: 'asc', label: 'Oldest first' },
                  ]}
                />
              </FilterBar>
            }
            emptyState={
              <EmptyState
                icon={FileText}
                size="sm"
                title={draftTotal === 0 && selectedStages.length === 0 ? 'No drafts yet' : 'No drafts match these filters'}
                description={
                  draftTotal === 0 && selectedStages.length === 0
                    ? 'Every draft starts from a brief, and every brief starts from an accepted content opportunity. Accept one on the Opportunities screen, create its brief, then start a draft from the Briefs tab here.'
                    : 'Clear the stage and status filters to see the whole pipeline.'
                }
                action={
                  draftTotal === 0 && selectedStages.length === 0 ? (
                    <Button asChild size="sm">
                      <Link href={`/sites/${website.id}/opportunities`}>Find content opportunities</Link>
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  )
                }
              />
            }
          />
        </TabsContent>

        <TabsContent value="briefs" className="space-y-2 pt-4">
          <DataTable<BriefRow>
            data={briefs}
            columns={briefColumns}
            getRowId={(row) => row.id}
            caption="Content briefs for this website"
            searchable
            searchPlaceholder="Search briefs…"
            defaultSort="createdAt"
            defaultOrder="desc"
            itemLabel="briefs"
            exportable={briefTotal <= briefs.length}
            exportFilename={`${website.domain}-content-briefs`}
            stickyHeader
            maxHeight="calc(100vh - 26rem)"
            emptyState={
              <EmptyState
                icon={ClipboardList}
                size="sm"
                title="No briefs for this site"
                description="A brief carries the target keyword, intent and suggested URL across from an accepted content opportunity. Accept one on the Opportunities screen to create the first."
                action={
                  <Button asChild size="sm">
                    <Link href={`/sites/${website.id}/opportunities`}>Review opportunities</Link>
                  </Button>
                }
              />
            }
          />
          {briefTotal > briefs.length ? (
            <p className="text-2xs text-muted-foreground">
              Showing the {formatNumber(briefs.length)} most recent of {formatNumber(briefTotal)} briefs. Sorting
              and search on this tab apply to those {formatNumber(briefs.length)} only.
            </p>
          ) : null}
        </TabsContent>
      </Tabs>

      {confirmDialog}
    </div>
  );
}
