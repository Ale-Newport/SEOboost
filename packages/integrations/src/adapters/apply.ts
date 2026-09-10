import {
  ACTION_RISK_BY_TYPE,
  ALWAYS_REQUIRES_APPROVAL,
  createLogger,
  errorMessage,
  truncate,
} from '@seo/shared';
import type { IntegrationProvider } from '@seo/db';
import { getAdapterForWebsite, type AdapterProvider, type GetAdapterOptions } from './registry';
import type {
  AdapterCapabilities,
  AdapterResult,
  ContentStatus,
  JsonValue,
  RedirectType,
  RemoteContent,
  WebsiteAdapter,
} from './types';

/**
 * The guarded path between an approved SeoAction and a live website.
 *
 * Nothing else in the platform should call an adapter's mutating methods directly: this
 * module is where the four things that keep automation safe live together —
 *
 *  1. **Adapter resolution** — a typed refusal when nothing is connected.
 *  2. **The approval gate** — HIGH-risk action types (and everything in
 *     `ALWAYS_REQUIRES_APPROVAL`) refuse to run without an `approvedByUserId`, at every
 *     autonomy level. The UI enforcing this is not enough; the executor must too.
 *  3. **The capability gate** — an action is refused before any network call when the
 *     adapter cannot perform it, so a Webflow site never gets a half-applied redirect.
 *  4. **The before-snapshot** — captured immediately before the write and returned for
 *     ChangeLog/ActionExecution, which is what makes a change reversible by record.
 *
 * `dryRun` runs 1–4 and then stops, returning the exact intended diff without touching the
 * site. That is the same code path a real apply takes, so a preview cannot drift from what
 * would actually happen.
 */

const log = createLogger('adapters:apply');

export type ActionRiskLevel = 'SAFE' | 'MEDIUM' | 'HIGH';

/** Mirrors the Prisma `ActionType` enum (both are keyed off the same shared constant). */
export type ApplyActionType = keyof typeof ACTION_RISK_BY_TYPE;

export interface InternalLinkInsertion {
  /** Text to look for in the body. The document's own casing is preserved when it matches. */
  anchor: string;
  href: string;
  title?: string;
}

export interface ApplyPayload {
  /** The adapter-specific content id (`post:12`, `article:1:2`, `<collection>/<item>`, a file path…). */
  externalId?: string;
  title?: string;
  metaTitle?: string;
  metaDescription?: string;
  canonicalUrl?: string;
  noindex?: boolean;
  slug?: string;
  excerpt?: string;
  bodyHtml?: string;
  bodyMarkdown?: string;
  status?: ContentStatus;
  structuredData?: JsonValue;
  /** ADD_INTERNAL_LINKS: the approved anchor → target pairs. */
  links?: readonly InternalLinkInsertion[];
  /** CREATE_REDIRECT. */
  from?: string;
  to?: string;
  redirectType?: RedirectType;
  /** Git-backed adapters use this as the commit message. */
  commitMessage?: string;
}

/** One intended field change, in the shape ChangeLog stores. */
export interface FieldDiff {
  field: string;
  before: string | null;
  after: string | null;
}

export type ApplyFailureCode =
  | 'NO_ADAPTER'
  | 'APPROVAL_REQUIRED'
  | 'UNSUPPORTED_ACTION'
  | 'MISSING_CAPABILITY'
  | 'INVALID_PAYLOAD'
  | 'READ_FAILED'
  | 'NO_CHANGE'
  | 'ADAPTER_ERROR';

export interface ApplyChangeInput {
  websiteId: string;
  /** A Prisma `ActionType` value. Unknown strings are treated as HIGH risk and refused. */
  actionType: string;
  payload: ApplyPayload;
  /** Run every guard and produce the diff, but perform no write. */
  dryRun?: boolean;
  /** The approving user's id. Required for HIGH-risk action types; recorded on the result. */
  approvedByUserId?: string | null;
  /** Force one integration provider instead of the site's preferred adapter. */
  provider?: IntegrationProvider;
}

export interface ApplyChangeResult {
  ok: boolean;
  dryRun: boolean;
  actionType: string;
  risk: ActionRiskLevel;
  requiresApproval: boolean;
  approvedByUserId?: string;
  adapter?: string;
  provider?: AdapterProvider;
  /** Snapshot taken immediately before the write. `null` when the adapter cannot read. */
  before: RemoteContent | null;
  /**
   * Real apply: the content re-read after the write (`null` when the adapter cannot read).
   * Dry run: the projected result of applying `changes` to `before`.
   */
  after: RemoteContent | null;
  /** The intended field-level change set — populated for dry runs and real applies alike. */
  changes: FieldDiff[];
  externalId?: string;
  url?: string;
  /** Which mechanism carried the write ('yoast', 'metafield:global', 'frontmatter'…). */
  via?: string;
  error?: string;
  errorCode?: ApplyFailureCode;
  warnings: string[];
}

// ── action → adapter operation ────────────────────────────────────────────────

type OperationKind = 'metadata' | 'content' | 'publish' | 'links' | 'structuredData' | 'redirect';

interface OperationPlan {
  kind: OperationKind;
  /** The capability that must be declared before anything is attempted. */
  capability: keyof AdapterCapabilities;
  /** True when the operation must read the current body before it can build the new one. */
  needsRead: boolean;
}

/**
 * `UPDATE_TITLE` maps to `updateMetadata`, not to the content title: in SEO an action
 * called "update title" means the `<title>` tag. Adapters that have no separate SEO title
 * (git frontmatter) already fold it onto their title field.
 */
function planOperation(actionType: string, payload: ApplyPayload): OperationPlan | null {
  switch (actionType) {
    case 'UPDATE_TITLE':
    case 'UPDATE_META_DESCRIPTION':
      return { kind: 'metadata', capability: 'updateMetadata', needsRead: false };
    case 'UPDATE_CONTENT':
    case 'REFRESH_CONTENT':
      return { kind: 'content', capability: 'updateContent', needsRead: false };
    case 'PUBLISH_CONTENT':
      return { kind: 'publish', capability: 'publish', needsRead: false };
    case 'ADD_INTERNAL_LINKS':
      return { kind: 'links', capability: 'updateContent', needsRead: true };
    case 'ADD_STRUCTURED_DATA':
      return { kind: 'structuredData', capability: 'injectStructuredData', needsRead: false };
    case 'CREATE_REDIRECT':
      return { kind: 'redirect', capability: 'createRedirect', needsRead: false };
    // Heterogeneous by nature: the payload decides whether these are a metadata or a body
    // change. CUSTOM is HIGH risk and in ALWAYS_REQUIRES_APPROVAL, so routing it by payload
    // still cannot run without a human approval.
    case 'FIX_TECHNICAL_ISSUE':
    case 'GEO_IMPROVEMENT':
    case 'CUSTOM':
      if (
        payload.metaTitle !== undefined ||
        payload.metaDescription !== undefined ||
        payload.canonicalUrl !== undefined ||
        payload.noindex !== undefined
      ) {
        return { kind: 'metadata', capability: 'updateMetadata', needsRead: false };
      }
      if (
        payload.bodyHtml !== undefined ||
        payload.bodyMarkdown !== undefined ||
        payload.title !== undefined ||
        payload.slug !== undefined ||
        payload.excerpt !== undefined ||
        payload.status !== undefined
      ) {
        return { kind: 'content', capability: 'updateContent', needsRead: false };
      }
      return null;
    default:
      return null;
  }
}

/**
 * `payload.title` means the `<title>` tag only for UPDATE_TITLE; for every other action it
 * is the content headline. Both the intent builder and the executor resolve it here so a
 * dry-run diff can never promise a metaTitle write that the real apply would not send.
 */
function metaTitleFor(actionType: string, payload: ApplyPayload): string | undefined {
  return payload.metaTitle ?? (actionType === 'UPDATE_TITLE' ? payload.title : undefined);
}

export function riskForActionType(actionType: string): ActionRiskLevel {
  const known = (ACTION_RISK_BY_TYPE as Record<string, ActionRiskLevel | undefined>)[actionType];
  // An action type this build does not know about is treated as HIGH: fail closed.
  return known ?? 'HIGH';
}

export function actionRequiresApproval(actionType: string): boolean {
  return (
    riskForActionType(actionType) === 'HIGH' ||
    (ALWAYS_REQUIRES_APPROVAL as readonly string[]).includes(actionType)
  );
}

// ── entry point ───────────────────────────────────────────────────────────────

/**
 * Apply one approved change to a website through its adapter.
 *
 * Never throws for an expected failure (nothing connected, missing approval, unsupported
 * operation, provider error) — the caller writes the returned object straight into an
 * ActionExecution row, so a failure must be as structured as a success.
 */
export async function applyChange(input: ApplyChangeInput): Promise<ApplyChangeResult> {
  const dryRun = input.dryRun === true;
  const risk = riskForActionType(input.actionType);
  const requiresApproval = actionRequiresApproval(input.actionType);
  const base: ApplyChangeResult = {
    ok: false,
    dryRun,
    actionType: input.actionType,
    risk,
    requiresApproval,
    approvedByUserId: input.approvedByUserId ?? undefined,
    before: null,
    after: null,
    changes: [],
    warnings: [],
  };

  // 1. Resolve the adapter.
  const opts: GetAdapterOptions = input.provider ? { provider: input.provider } : {};
  const resolution = await getAdapterForWebsite(input.websiteId, opts);
  if (!resolution.adapter) {
    return { ...base, errorCode: 'NO_ADAPTER', error: resolution.reason };
  }
  const { adapter, provider } = resolution;
  const withAdapter: ApplyChangeResult = { ...base, adapter: adapter.name, provider };

  // 2. Approval gate — enforced here, not only in the UI.
  if (requiresApproval && !input.approvedByUserId) {
    return {
      ...withAdapter,
      errorCode: 'APPROVAL_REQUIRED',
      error: `${input.actionType} is a ${risk.toLowerCase()}-risk change and cannot be applied without an explicit human approval. Approve it in the review queue first.`,
    };
  }

  // 3. Capability gate.
  const plan = planOperation(input.actionType, input.payload);
  if (!plan) {
    return {
      ...withAdapter,
      errorCode: 'UNSUPPORTED_ACTION',
      error: `${input.actionType} is not a website change this executor can apply. It is handled elsewhere (a brief, a report, or an indexing submission) or its payload was empty.`,
    };
  }
  if (!adapter.capabilities[plan.capability]) {
    return {
      ...withAdapter,
      errorCode: 'MISSING_CAPABILITY',
      error: `The ${adapter.name} adapter cannot ${describeCapability(plan.capability)} for this site, so ${input.actionType} was not attempted.`,
    };
  }

  const validation = validatePayload(plan, input.payload);
  if (validation) return { ...withAdapter, errorCode: 'INVALID_PAYLOAD', error: validation };

  // 4. Before-snapshot. A redirect has no content target, so it is the one operation
  //    that legitimately has nothing to snapshot.
  const externalId = input.payload.externalId?.trim() ?? '';
  let before: RemoteContent | null = null;
  const warnings: string[] = [];

  if (plan.kind !== 'redirect') {
    if (adapter.capabilities.readContent) {
      const snapshot = await adapter.getContent(externalId);
      if (!snapshot.ok) {
        // A required read (internal links) cannot continue; an optional one degrades.
        if (plan.needsRead) {
          return {
            ...withAdapter,
            errorCode: 'READ_FAILED',
            error: `Could not read "${externalId}" before applying ${input.actionType}: ${snapshot.error}`,
          };
        }
        warnings.push(`No before-snapshot was captured (${snapshot.error}), so this change cannot be rolled back automatically.`);
      } else {
        before = snapshot.data;
      }
    } else if (plan.needsRead) {
      return {
        ...withAdapter,
        errorCode: 'MISSING_CAPABILITY',
        error: `${input.actionType} needs to read the current page body, which the ${adapter.name} adapter cannot do. Connect a CMS or git integration for this site.`,
      };
    } else {
      warnings.push(
        `The ${adapter.name} adapter cannot read the site, so this change is recorded without a before-snapshot and cannot be rolled back automatically.`,
      );
    }
  }

  const withBefore: ApplyChangeResult = { ...withAdapter, before, externalId: externalId || undefined, warnings };

  // 5. Build the intended change set, then either project it (dry run) or apply it.
  const intent = buildIntent(plan, input.actionType, input.payload, before);
  if ('error' in intent) {
    return { ...withBefore, errorCode: intent.code, error: intent.error };
  }

  if (dryRun) {
    return {
      ...withBefore,
      ok: true,
      changes: intent.changes,
      after: before ? projectAfter(before, intent.changes) : null,
      url: before?.url,
      warnings: [
        ...warnings,
        ...intent.warnings,
        'Dry run: nothing was sent to the website.',
      ],
    };
  }

  const outcome = await execute(adapter, plan, input, intent, externalId);
  if (!outcome.ok) {
    return {
      ...withBefore,
      changes: intent.changes,
      errorCode: 'ADAPTER_ERROR',
      error: outcome.error,
      warnings: [...warnings, ...intent.warnings, ...(outcome.warnings ?? [])],
    };
  }

  // 6. Re-read so `after` is the site's own state, never our optimistic projection.
  let after: RemoteContent | null = null;
  const postWarnings: string[] = [];
  if (plan.kind !== 'redirect' && adapter.capabilities.readContent) {
    const verify = await adapter.getContent(outcome.externalId ?? externalId);
    if (verify.ok) after = verify.data;
    else postWarnings.push(`The change was applied but the page could not be re-read to confirm it: ${verify.error}`);
  }

  log.info('change applied', {
    websiteId: input.websiteId,
    actionType: input.actionType,
    adapter: adapter.name,
    externalId: outcome.externalId ?? externalId,
    fields: intent.changes.map((c) => c.field),
  });

  return {
    ...withBefore,
    ok: true,
    changes: intent.changes,
    after,
    // `externalId` is '' for a redirect, which has no content target — keep that undefined
    // rather than writing an empty string into the ChangeLog row.
    externalId: outcome.externalId ?? (externalId || undefined),
    url: outcome.url ?? before?.url,
    via: outcome.via,
    warnings: [...warnings, ...intent.warnings, ...(outcome.warnings ?? []), ...postWarnings],
  };
}

// ── revert ────────────────────────────────────────────────────────────────────

/** Fields a revert can restore by writing the old value back through an adapter. */
const REVERTABLE_METADATA_FIELDS: readonly string[] = ['metaTitle', 'metaDescription', 'canonicalUrl'];
const REVERTABLE_CONTENT_FIELDS: readonly string[] = [
  'title',
  'slug',
  'excerpt',
  'bodyHtml',
  'bodyMarkdown',
  'status',
];

export interface RevertChangeInput {
  websiteId: string;
  /** The `before` snapshot the original apply captured — the state to restore. */
  before: RemoteContent;
  /** The original apply's change set. Only the fields it actually touched are restored. */
  changes: readonly FieldDiff[];
  dryRun?: boolean;
  /**
   * Who asked for the rollback. A revert is itself a live write, so it goes through the
   * same approval gate as any other change.
   */
  approvedByUserId?: string | null;
  provider?: IntegrationProvider;
  commitMessage?: string;
}

export interface RevertChangeResult {
  ok: boolean;
  dryRun: boolean;
  /** One entry per adapter operation the revert needed (metadata and/or content). */
  steps: ApplyChangeResult[];
  error?: string;
  errorCode?: ApplyFailureCode | 'NOT_REVERTABLE';
  warnings: string[];
}

/**
 * Which of a change set's fields can be undone by writing the snapshot back.
 *
 * A redirect cannot be deleted through any adapter here, a `noindex` flip has no stored
 * before-value, and structured data is injected as an opaque block rather than a field —
 * so those are reported as non-revertable instead of being half-applied.
 */
export function describeRevertability(changes: readonly FieldDiff[]): {
  revertable: string[];
  blocked: string[];
} {
  const revertable: string[] = [];
  const blocked: string[] = [];
  for (const change of changes) {
    if (REVERTABLE_METADATA_FIELDS.includes(change.field) || REVERTABLE_CONTENT_FIELDS.includes(change.field)) {
      revertable.push(change.field);
    } else {
      blocked.push(change.field);
    }
  }
  return { revertable, blocked };
}

/**
 * Undo a previously applied change by writing its `before` snapshot back to the site.
 *
 * This is the other half of the invariant every adapter result carries a `beforeState` for:
 * without it, `beforeState` is an audit record nobody can act on. It reuses `applyChange`
 * verbatim — same approval, capability and snapshot gates — so a rollback is as guarded and
 * as auditable as the change it undoes, and never throws for an expected failure.
 *
 * A field whose recorded `before` was `null` (the value did not exist) is restored by
 * writing an empty value, which is the closest any CMS API gets to "remove it"; that is
 * surfaced as a warning rather than silently pretending the field is gone.
 */
export async function revertChange(input: RevertChangeInput): Promise<RevertChangeResult> {
  const dryRun = input.dryRun === true;
  const base: RevertChangeResult = { ok: false, dryRun, steps: [], warnings: [] };

  const { revertable, blocked } = describeRevertability(input.changes);
  if (!revertable.length) {
    return {
      ...base,
      errorCode: 'NOT_REVERTABLE',
      error: blocked.length
        ? `None of the changed fields can be rolled back automatically (${blocked.join(', ')}). Undo this one by hand on the site.`
        : 'The recorded change set is empty, so there is nothing to roll back.',
    };
  }

  const externalId = input.before.externalId;
  if (!externalId) {
    return {
      ...base,
      errorCode: 'NOT_REVERTABLE',
      error: 'The recorded snapshot has no content id, so the page to restore cannot be identified.',
    };
  }

  const warnings: string[] = [];
  if (blocked.length) {
    warnings.push(`These fields were left as they are because they cannot be rolled back automatically: ${blocked.join(', ')}.`);
  }

  const cleared: string[] = [];
  const valueFor = (field: string): string | undefined => {
    const change = input.changes.find((c) => c.field === field);
    if (!change) return undefined;
    if (change.before === null) cleared.push(field);
    return change.before ?? '';
  };

  const metadataPayload: ApplyPayload = { externalId };
  let hasMetadata = false;
  for (const field of REVERTABLE_METADATA_FIELDS) {
    const value = valueFor(field);
    if (value === undefined) continue;
    hasMetadata = true;
    if (field === 'metaTitle') metadataPayload.metaTitle = value;
    else if (field === 'metaDescription') metadataPayload.metaDescription = value;
    else metadataPayload.canonicalUrl = value;
  }

  const contentPayload: ApplyPayload = { externalId, commitMessage: input.commitMessage ?? 'seo: roll back change' };
  let hasContent = false;
  for (const field of REVERTABLE_CONTENT_FIELDS) {
    const value = valueFor(field);
    if (value === undefined) continue;
    hasContent = true;
    if (field === 'title') contentPayload.title = value;
    else if (field === 'slug') contentPayload.slug = value;
    else if (field === 'excerpt') contentPayload.excerpt = value;
    else if (field === 'bodyHtml') contentPayload.bodyHtml = value;
    else if (field === 'bodyMarkdown') contentPayload.bodyMarkdown = value;
    else contentPayload.status = (value || 'draft') as ContentStatus;
  }

  if (cleared.length) {
    warnings.push(
      `${cleared.join(', ')} did not exist before the change, so ${cleared.length === 1 ? 'it was' : 'they were'} cleared rather than removed — most platforms have no way to delete the field.`,
    );
  }

  const steps: ApplyChangeResult[] = [];
  // Content first: a metadata write on some adapters re-reads the body, so restoring the
  // body before the tags keeps the second snapshot consistent with the first.
  if (hasContent) {
    steps.push(
      await applyChange({
        websiteId: input.websiteId,
        actionType: 'UPDATE_CONTENT',
        payload: contentPayload,
        dryRun,
        approvedByUserId: input.approvedByUserId,
        provider: input.provider,
      }),
    );
  }
  // Stop after a hard content failure — a half-reverted page is worse than an un-reverted
  // one. NO_CHANGE is not a failure here: it means the body already holds the old value.
  const contentStep = steps[0];
  const contentBlocked = contentStep !== undefined && !contentStep.ok && contentStep.errorCode !== 'NO_CHANGE';
  if (hasMetadata && !contentBlocked) {
    steps.push(
      await applyChange({
        websiteId: input.websiteId,
        // The <title>/description tags are the target, so this is a metadata action.
        actionType: 'UPDATE_META_DESCRIPTION',
        payload: metadataPayload,
        dryRun,
        approvedByUserId: input.approvedByUserId,
        provider: input.provider,
      }),
    );
  }

  const failed = steps.filter((s) => !s.ok);
  // NO_CHANGE means the site already holds the old value, which is a successful rollback.
  const realFailures = failed.filter((s) => s.errorCode !== 'NO_CHANGE');

  return {
    ok: steps.length > 0 && realFailures.length === 0,
    dryRun,
    steps,
    errorCode: realFailures[0]?.errorCode,
    error: realFailures.length ? realFailures.map((s) => s.error).filter(Boolean).join('; ') : undefined,
    warnings: [...warnings, ...steps.flatMap((s) => s.warnings)],
  };
}

// ── intent ────────────────────────────────────────────────────────────────────

interface Intent {
  changes: FieldDiff[];
  warnings: string[];
  /** Body computed by the links pass, carried through to the write. */
  bodyHtml?: string;
  bodyMarkdown?: string;
}

interface IntentFailure {
  error: string;
  code: ApplyFailureCode;
}

function buildIntent(
  plan: OperationPlan,
  actionType: string,
  payload: ApplyPayload,
  before: RemoteContent | null,
): Intent | IntentFailure {
  switch (plan.kind) {
    case 'metadata': {
      const changes: FieldDiff[] = [];
      // `known` is false when no snapshot exists (a write-only adapter). Without one we
      // cannot claim a value already matches, so the write must still be attempted.
      const known = before !== null;
      pushChange(changes, 'metaTitle', before?.metaTitle, metaTitleFor(actionType, payload), known);
      pushChange(changes, 'metaDescription', before?.metaDescription, payload.metaDescription, known);
      pushChange(changes, 'canonicalUrl', before?.canonicalUrl, payload.canonicalUrl, known);
      if (payload.noindex !== undefined) {
        changes.push({ field: 'noindex', before: null, after: String(payload.noindex) });
      }
      if (!changes.length) {
        return { code: 'NO_CHANGE', error: 'The requested metadata already matches what is on the page.' };
      }
      return { changes, warnings: [] };
    }
    case 'content': {
      const changes: FieldDiff[] = [];
      const known = before !== null;
      pushChange(changes, 'title', before?.title, payload.title, known);
      pushChange(changes, 'slug', before?.slug, payload.slug, known);
      pushChange(changes, 'excerpt', before?.excerpt, payload.excerpt, known);
      pushChange(changes, 'bodyHtml', before?.bodyHtml, payload.bodyHtml, known);
      pushChange(changes, 'bodyMarkdown', before?.bodyMarkdown, payload.bodyMarkdown, known);
      pushChange(changes, 'status', before?.status, payload.status, known);
      if (!changes.length) {
        return { code: 'NO_CHANGE', error: 'The supplied content is identical to what is already published.' };
      }
      return { changes, warnings: [] };
    }
    case 'publish': {
      if (before && before.status === 'publish') {
        return { code: 'NO_CHANGE', error: 'This content is already published.' };
      }
      return {
        changes: [{ field: 'status', before: before?.status ?? null, after: 'publish' }],
        warnings: [],
      };
    }
    case 'links': {
      // `needsRead` guarantees a before-state here; the check keeps the type honest.
      if (!before) return { code: 'READ_FAILED', error: 'Internal links need the current page body, which was not read.' };
      const isMarkdown = before.bodyHtml === undefined && before.bodyMarkdown !== undefined;
      const body = (isMarkdown ? before.bodyMarkdown : before.bodyHtml) ?? '';
      if (!body.trim()) {
        return { code: 'NO_CHANGE', error: 'The page body is empty, so there is nowhere to add internal links.' };
      }

      const result = insertInternalLinks(body, payload.links ?? [], isMarkdown ? 'markdown' : 'html');
      if (!result.inserted.length) {
        return {
          code: 'NO_CHANGE',
          error: `None of the ${payload.links?.length ?? 0} approved anchors could be linked — ${summariseSkips(result)}.`,
        };
      }

      const field = isMarkdown ? 'bodyMarkdown' : 'bodyHtml';
      const warnings = result.skipped.length
        ? [`${result.skipped.length} anchor(s) were skipped — ${summariseSkips(result)}.`]
        : [];
      return {
        changes: [{ field, before: body, after: result.body }],
        warnings: [
          ...warnings,
          `Inserted ${result.inserted.length} internal link(s): ${result.inserted.map((l) => `"${l.anchor}" → ${l.href}`).join(', ')}.`,
        ],
        ...(isMarkdown ? { bodyMarkdown: result.body } : { bodyHtml: result.body }),
      };
    }
    case 'structuredData': {
      const jsonLd = payload.structuredData;
      if (jsonLd === undefined || jsonLd === null) {
        return { code: 'INVALID_PAYLOAD', error: 'No JSON-LD was supplied for the structured-data change.' };
      }
      return {
        changes: [
          {
            field: 'structuredData',
            before: before?.structuredData?.length ? JSON.stringify(before.structuredData) : null,
            after: JSON.stringify(jsonLd),
          },
        ],
        warnings: [],
      };
    }
    case 'redirect': {
      return {
        changes: [
          { field: 'redirect', before: null, after: `${payload.from ?? ''} → ${payload.to ?? ''} (${payload.redirectType ?? 301})` },
        ],
        warnings: [],
      };
    }
  }
}

/**
 * Record a field when the new value is present and actually different.
 *
 * `known` says whether a before-snapshot exists at all. When it does not, `before` is
 * `undefined` because nothing was read — not because the field is empty — so skipping the
 * change would turn "we cannot tell" into a false "already up to date".
 */
function pushChange(
  changes: FieldDiff[],
  field: string,
  before: string | undefined,
  after: string | undefined,
  known: boolean,
): void {
  if (after === undefined) return;
  if (known && (before ?? '') === after) return;
  changes.push({ field, before: before ?? null, after });
}

function summariseSkips(result: InsertLinksResult): string {
  const counts = new Map<string, number>();
  for (const skip of result.skipped) counts.set(skip.reason, (counts.get(skip.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, n]) => `${n} ${SKIP_LABELS[reason] ?? reason}`).join(', ');
}

const SKIP_LABELS: Record<string, string> = {
  NOT_FOUND: 'anchor text not found in the body (or only inside a heading, link or code block)',
  ALREADY_LINKED: 'already linked to that target',
  DUPLICATE_ANCHOR: 'duplicate anchor in the request',
  INVALID: 'invalid anchor or href',
};

/** Dry-run projection: `before` with the intended changes applied, for a side-by-side preview. */
function projectAfter(before: RemoteContent, changes: readonly FieldDiff[]): RemoteContent {
  const after: RemoteContent = { ...before };
  for (const change of changes) {
    const value = change.after;
    switch (change.field) {
      case 'title':
        if (value !== null) after.title = value;
        break;
      case 'slug':
        after.slug = value ?? undefined;
        break;
      case 'excerpt':
        after.excerpt = value ?? undefined;
        break;
      case 'metaTitle':
        after.metaTitle = value ?? undefined;
        break;
      case 'metaDescription':
        after.metaDescription = value ?? undefined;
        break;
      case 'canonicalUrl':
        after.canonicalUrl = value ?? undefined;
        break;
      case 'bodyHtml':
        after.bodyHtml = value ?? undefined;
        break;
      case 'bodyMarkdown':
        after.bodyMarkdown = value ?? undefined;
        break;
      case 'status':
        // `changes` only ever carries a ContentStatus in this field (see buildIntent).
        after.status = (value as ContentStatus | null) ?? undefined;
        break;
      case 'structuredData': {
        // The value was produced by JSON.stringify above, but a projection must never be the
        // thing that throws out of a dry run — fall back to the existing blocks if it does.
        if (!value) break;
        try {
          const parsed = JSON.parse(value) as JsonValue;
          after.structuredData = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          after.structuredData = before.structuredData;
        }
        break;
      }
      default:
        // `noindex` and `redirect` have no RemoteContent field; they stay visible in `changes`.
        break;
    }
  }
  return after;
}

// ── execution ─────────────────────────────────────────────────────────────────

interface ExecutionOutcome {
  ok: boolean;
  error?: string;
  externalId?: string;
  url?: string;
  via?: string;
  warnings?: string[];
}

async function execute(
  adapter: WebsiteAdapter,
  plan: OperationPlan,
  input: ApplyChangeInput,
  intent: Intent,
  externalId: string,
): Promise<ExecutionOutcome> {
  const { payload } = input;
  try {
    switch (plan.kind) {
      case 'metadata': {
        const result = await adapter.updateMetadata(externalId, {
          metaTitle: metaTitleFor(input.actionType, payload),
          metaDescription: payload.metaDescription,
          canonicalUrl: payload.canonicalUrl,
          noindex: payload.noindex,
        });
        if (!result.ok) return fromFailure(result);
        return {
          ok: true,
          externalId: result.externalId,
          url: result.url,
          via: result.data.via,
          warnings: warningsOf(result, unwrittenFields(intent, result.data.fieldsWritten)),
        };
      }
      case 'content': {
        const result = await adapter.updateContent(externalId, {
          title: payload.title,
          slug: payload.slug,
          excerpt: payload.excerpt,
          bodyHtml: payload.bodyHtml,
          bodyMarkdown: payload.bodyMarkdown,
          status: payload.status,
          commitMessage: payload.commitMessage,
        });
        if (!result.ok) return fromFailure(result);
        return { ok: true, externalId: result.data.id, url: result.data.url, via: adapter.name, warnings: warningsOf(result) };
      }
      case 'links': {
        const result = await adapter.updateContent(externalId, {
          bodyHtml: intent.bodyHtml,
          bodyMarkdown: intent.bodyMarkdown,
          commitMessage: payload.commitMessage ?? 'seo: add internal links',
        });
        if (!result.ok) return fromFailure(result);
        return { ok: true, externalId: result.data.id, url: result.data.url, via: adapter.name, warnings: warningsOf(result) };
      }
      case 'publish': {
        if (!adapter.publishContent) {
          return { ok: false, error: `The ${adapter.name} adapter declares the publish capability but implements no publish method.` };
        }
        const result = await adapter.publishContent(externalId);
        if (!result.ok) return fromFailure(result);
        return { ok: true, externalId: result.data.id, url: result.data.url, via: adapter.name, warnings: warningsOf(result) };
      }
      case 'structuredData': {
        if (!adapter.injectStructuredData) {
          return { ok: false, error: `The ${adapter.name} adapter declares structured-data support but implements no method for it.` };
        }
        const result = await adapter.injectStructuredData(externalId, payload.structuredData ?? null);
        if (!result.ok) return fromFailure(result);
        return { ok: true, externalId: result.externalId, url: result.url, via: result.data.via, warnings: warningsOf(result) };
      }
      case 'redirect': {
        if (!adapter.createRedirect) {
          return { ok: false, error: `The ${adapter.name} adapter declares redirect support but implements no method for it.` };
        }
        const result = await adapter.createRedirect(payload.from ?? '', payload.to ?? '', payload.redirectType ?? 301);
        if (!result.ok) return fromFailure(result);
        return { ok: true, url: result.url, via: result.data.via, warnings: warningsOf(result) };
      }
    }
  } catch (err) {
    // Adapters are written not to throw, but a bug there must still produce a recordable
    // failure rather than killing the worker mid-execution.
    log.error('adapter threw during apply', { adapter: adapter.name, error: errorMessage(err) });
    return { ok: false, error: `The ${adapter.name} adapter threw while applying the change: ${errorMessage(err)}` };
  }
}

function fromFailure(result: AdapterResult<unknown>): ExecutionOutcome {
  return {
    ok: false,
    error: result.ok ? 'unknown adapter failure' : result.error,
    warnings: result.warnings,
  };
}

function warningsOf(result: AdapterResult<unknown>, extra: string[] = []): string[] {
  return [...(result.warnings ?? []), ...extra];
}

/** Surface metadata fields the platform confirmed it did *not* store. */
function unwrittenFields(intent: Intent, written: readonly string[]): string[] {
  const missed = intent.changes
    .map((c) => c.field)
    .filter((field) => field !== 'noindex' && !written.includes(field));
  return missed.length ? [`The platform did not confirm storing: ${missed.join(', ')}.`] : [];
}

function describeCapability(capability: keyof AdapterCapabilities): string {
  switch (capability) {
    case 'readContent':
      return 'read content';
    case 'updateContent':
      return 'update content';
    case 'createContent':
      return 'create content';
    case 'publish':
      return 'publish content';
    case 'updateMetadata':
      return 'write SEO metadata';
    case 'injectStructuredData':
      return 'inject structured data';
    case 'createRedirect':
      return 'create redirects';
    case 'updateSitemap':
      return 'update the sitemap';
  }
}

function validatePayload(plan: OperationPlan, payload: ApplyPayload): string | null {
  if (plan.kind === 'redirect') {
    if (!payload.from?.trim() || !payload.to?.trim()) return 'A redirect needs both `from` and `to`.';
    return null;
  }
  if (!payload.externalId?.trim()) {
    return 'The action payload has no `externalId`, so there is no page to change. Set it to the CMS id (or file path) of the target page.';
  }
  if (plan.kind === 'links' && !payload.links?.length) {
    return 'No approved anchors were supplied for the internal-link change.';
  }
  return null;
}

// ── internal link insertion ───────────────────────────────────────────────────

export type LinkSkipReason = 'NOT_FOUND' | 'ALREADY_LINKED' | 'DUPLICATE_ANCHOR' | 'INVALID';

export interface InsertLinksResult {
  body: string;
  inserted: InternalLinkInsertion[];
  skipped: Array<{ link: InternalLinkInsertion; reason: LinkSkipReason }>;
}

export type LinkBodyFormat = 'html' | 'markdown';

/**
 * Insert approved internal links into a body, once each.
 *
 * The rules exist because an over-eager linker is worse than none at all:
 *  - **First occurrence only.** Linking every mention of a phrase reads as spam and dilutes
 *    the anchor signal.
 *  - **Never inside an existing link.** Nested `<a>` is invalid HTML and browsers recover
 *    from it unpredictably.
 *  - **Never inside a heading.** A link in an H2 changes how the page outline is read, and
 *    headings are usually hand-written.
 *  - **Never inside code, script, style or an HTML attribute.** Those are not prose.
 *  - **Skip a target that is already linked from this page** — a second link to the same URL
 *    adds nothing and usually looks like a mistake.
 *
 * The matched text keeps the document's own casing and spacing; only the surrounding tags
 * are added, so a diff shows exactly one insertion per link.
 */
export function insertInternalLinks(
  body: string,
  links: readonly InternalLinkInsertion[],
  format: LinkBodyFormat = 'html',
): InsertLinksResult {
  const inserted: InternalLinkInsertion[] = [];
  const skipped: InsertLinksResult['skipped'] = [];
  const seenAnchors = new Set<string>();
  let current = body;

  for (const link of links) {
    const anchor = link.anchor?.trim() ?? '';
    const href = link.href?.trim() ?? '';
    if (!anchor || !href) {
      skipped.push({ link, reason: 'INVALID' });
      continue;
    }
    const key = anchor.toLowerCase();
    if (seenAnchors.has(key)) {
      skipped.push({ link, reason: 'DUPLICATE_ANCHOR' });
      continue;
    }
    seenAnchors.add(key);

    if (alreadyLinksTo(current, href, format)) {
      skipped.push({ link, reason: 'ALREADY_LINKED' });
      continue;
    }

    // Ranges are recomputed per link so a link inserted by an earlier pass protects itself.
    const protectedRanges = format === 'markdown' ? markdownProtectedRanges(current) : htmlProtectedRanges(current);
    const match = findUnprotected(current, anchor, protectedRanges);
    if (!match) {
      skipped.push({ link, reason: 'NOT_FOUND' });
      continue;
    }

    const text = current.slice(match.start, match.end);
    const replacement =
      format === 'markdown' ? renderMarkdownLink(text, href, link.title) : renderHtmlLink(text, href, link.title);
    current = `${current.slice(0, match.start)}${replacement}${current.slice(match.end)}`;
    inserted.push({ anchor, href, title: link.title });
  }

  return { body: current, inserted, skipped };
}

/** Half-open `[start, end)` slice of a body that must not be touched. */
export interface TextRange {
  start: number;
  end: number;
}

function collect(source: string, patterns: readonly RegExp[]): TextRange[] {
  const ranges: TextRange[] = [];
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let match = re.exec(source);
    while (match) {
      if (match[0].length > 0) ranges.push({ start: match.index, end: match.index + match[0].length });
      // Zero-length matches would loop forever; nudge past them.
      if (match.index === re.lastIndex) re.lastIndex += 1;
      match = re.exec(source);
    }
  }
  return ranges;
}

const HTML_PROTECTED: readonly RegExp[] = [
  /<a\b[^>]*>[\s\S]*?<\/a\s*>/gi,
  /<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]\s*>/gi,
  /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
  /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
  /<pre\b[^>]*>[\s\S]*?<\/pre\s*>/gi,
  /<code\b[^>]*>[\s\S]*?<\/code\s*>/gi,
  /<!--[\s\S]*?-->/g,
  // Every remaining tag, so anchor text is never matched inside an attribute value.
  /<[^>]+>/g,
];

export function htmlProtectedRanges(html: string): TextRange[] {
  return collect(html, HTML_PROTECTED);
}

const MARKDOWN_PROTECTED: readonly RegExp[] = [
  /```[\s\S]*?```/g,
  /~~~[\s\S]*?~~~/g,
  /(?:^|\n)(?: {4}|\t)[^\n]*/g,
  /`[^`\n]*`/g,
  // Inline links/images, reference links and link definitions.
  /!?\[[^\]\n]*\]\([^)\n]*\)/g,
  /!?\[[^\]\n]*\]\[[^\]\n]*\]/g,
  /^ {0,3}\[[^\]\n]+\]:[^\n]*$/gm,
  // ATX headings and setext underlines (with the line they underline).
  /^ {0,3}#{1,6}[^\n]*$/gm,
  /^[^\n]+\n {0,3}(?:=+|-{2,}) *$/gm,
  /<[^>\n]+>/g,
  /https?:\/\/\S+/g,
];

export function markdownProtectedRanges(markdown: string): TextRange[] {
  return collect(markdown, MARKDOWN_PROTECTED);
}

/** Escape regex metacharacters, but let any run of whitespace match any run of whitespace. */
function anchorPattern(anchor: string): RegExp {
  const escaped = anchor
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '[\\s\\u00a0]+');
  // Unicode-aware word boundaries. The hyphen is part of the boundary class on purpose:
  // "SEO" inside "SEO-ish" is a different term and must not be linked.
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, 'giu');
}

function findUnprotected(source: string, anchor: string, ranges: readonly TextRange[]): TextRange | null {
  const re = anchorPattern(anchor);
  let match = re.exec(source);
  while (match) {
    const start = match.index;
    const end = start + match[0].length;
    if (!ranges.some((r) => start < r.end && end > r.start)) return { start, end };
    match = re.exec(source);
  }
  return null;
}

/** True when this body already points at the target, so a second link would be redundant. */
function alreadyLinksTo(body: string, href: string, format: LinkBodyFormat): boolean {
  if (format === 'markdown') {
    // `<…>` covers the angle-bracket destination form renderMarkdownLink emits.
    return new RegExp(`\\]\\(\\s*<?${escapeRegex(href)}>?[\\s)"']`, 'i').test(`${body} `);
  }
  return new RegExp(`href\\s*=\\s*["']${escapeRegex(href)}["']`, 'i').test(body);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderHtmlLink(text: string, href: string, title?: string): string {
  const titleAttr = title ? ` title="${escapeHtmlAttribute(title)}"` : '';
  return `<a href="${escapeHtmlAttribute(href)}"${titleAttr}>${text}</a>`;
}

function renderMarkdownLink(text: string, href: string, title?: string): string {
  const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : '';
  // A bare href containing a space or parenthesis terminates the destination early and
  // silently produces broken Markdown; the angle-bracket form is the escape hatch for it.
  const destination = /[\s()<>]/.test(href) ? `<${href.replace(/([<>])/g, '\\$1')}>` : href;
  return `[${text}](${destination}${titlePart})`;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Short, log-safe description of a change set. */
export function summariseChanges(changes: readonly FieldDiff[]): string {
  if (!changes.length) return 'no changes';
  return changes.map((c) => `${c.field}: ${truncate(c.after ?? '∅', 60)}`).join('; ');
}
