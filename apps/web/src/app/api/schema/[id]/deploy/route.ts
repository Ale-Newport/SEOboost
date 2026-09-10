import { z } from 'zod';
import {
  ActionRisk,
  ActionStatus,
  ActionType,
  DeploymentStatus,
  SchemaValidationStatus,
  json,
  prisma,
  readJson,
} from '@seo/db';
import { ConflictError, NotFoundError, createLogger } from '@seo/shared';
import { enqueue } from '@seo/queue';
import { validateJsonLd } from '@seo/seo-engine';
import { getAdapterForWebsite } from '@seo/integrations/adapters/registry';
import { readBody, requireWebsite, route } from '@/lib/api';
import { assertNotReadOnly, enqueueSummary, skipped } from '@/app/api/_lib/common';

const log = createLogger('api:schema');

/**
 * `POST /api/schema/[id]/deploy` — put a validated JSON-LD block on the live page.
 *
 * The deploy goes through the normal action pipeline (`SeoAction` → `actions.execute`) rather
 * than writing directly, so it inherits the executor's before/after snapshot, its ChangeLog
 * entry and its rollback record. Invalid markup is refused outright: shipping structured data
 * that Google rejects is worse than shipping none, and the validator already knows.
 */

const bodySchema = z.object({
  /**
   * The CMS content id to inject into. Adapters address content by their own id, and there is
   * no reliable URL → id lookup, so it is supplied by the caller (or inherited from a draft).
   */
  externalId: z.string().trim().max(300).optional(),
  /** Deploy despite validation warnings (errors are never overridable). */
  allowWarnings: z.boolean().optional(),
});

export const POST = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);
  await assertNotReadOnly();

  const item = await prisma.structuredDataItem.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      websiteId: true,
      pageId: true,
      schemaType: true,
      jsonLd: true,
      validationStatus: true,
      deploymentStatus: true,
      page: { select: { id: true, url: true, title: true } },
    },
  });
  if (!item) throw new NotFoundError('Structured data item');
  const website = await requireWebsite(user.id, item.websiteId);

  if (item.deploymentStatus === DeploymentStatus.PENDING) {
    throw new ConflictError('A deployment for this item is already queued.');
  }

  // Re-validate at deploy time: the row may have been edited since it was last checked.
  const jsonLd = readJson<unknown>(item.jsonLd, null);
  const validation = validateJsonLd(jsonLd);
  if (validation.status === 'INVALID') {
    await prisma.structuredDataItem.update({
      where: { id: item.id },
      data: {
        validationStatus: SchemaValidationStatus.INVALID,
        validationErrors: json(validation.issues),
      },
    });
    throw new ConflictError(
      `This markup is invalid and will not produce rich results: ${validation.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  if (validation.status === 'WARNING' && body.allowWarnings !== true) {
    throw new ConflictError(
      `This markup has ${validation.issues.length} warning(s): ${validation.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}. Re-send with allowWarnings: true to deploy anyway.`,
    );
  }

  const adapter = await getAdapterForWebsite(website.id);
  if (!adapter.adapter) {
    return skipped(
      adapter.reason,
      'Connect a CMS under Settings → Integrations before deploying structured data.',
    );
  }
  if (!adapter.adapter.capabilities.injectStructuredData) {
    return skipped(
      `The connected ${adapter.provider} integration cannot inject structured data.`,
      'Connect an integration that supports structured data, or add the JSON-LD to the page template yourself.',
    );
  }

  // A draft already published to this page knows the CMS id; reuse it rather than asking again.
  const inheritedExternalId = item.pageId
    ? (
        await prisma.contentDraft.findFirst({
          where: { websiteId: website.id, pageId: item.pageId, externalId: { not: null } },
          orderBy: { updatedAt: 'desc' },
          select: { externalId: true },
        })
      )?.externalId
    : null;

  const externalId = body.externalId ?? inheritedExternalId ?? null;
  if (!externalId) {
    return skipped(
      'No CMS content id is known for this page, so the adapter cannot be told where to write.',
      'Pass externalId (the post/page/item id in your CMS) with this request.',
    );
  }

  const targetUrl = item.page?.url ?? `${website.protocol}://${website.domain}`;

  const action = await prisma.seoAction.create({
    data: {
      websiteId: website.id,
      type: ActionType.ADD_STRUCTURED_DATA,
      title: `Deploy ${item.schemaType} markup${item.page ? ` to ${item.page.url}` : ''}`,
      // Deploying is an explicit human instruction, so the action starts already approved.
      status: ActionStatus.APPROVED,
      risk: ActionRisk.SAFE,
      reasoning:
        `${item.schemaType} JSON-LD validated as ${validation.status} and deployed on request ` +
        `by ${user.email || user.id}.`,
      evidence: json({
        structuredDataItemId: item.id,
        validation: { status: validation.status, issues: validation.issues, types: validation.types },
      }),
      affectedUrls: [targetUrl],
      payload: json({ externalId, structuredData: jsonLd }),
      sourceType: 'structured-data-item',
      sourceId: item.id,
      approvedAt: new Date(),
    },
    select: { id: true },
  });

  await prisma.structuredDataItem.update({
    where: { id: item.id },
    data: {
      deploymentStatus: DeploymentStatus.PENDING,
      validationStatus:
        validation.status === 'VALID' ? SchemaValidationStatus.VALID : SchemaValidationStatus.WARNING,
      validationErrors: json(validation.issues),
    },
  });

  const result = await enqueue(
    'actions.execute',
    { websiteId: website.id, actionId: action.id },
    { websiteId: website.id, trigger: 'manual', dedupeKey: `actions.execute:${action.id}` },
  );

  log.info('structured data deploy queued', { itemId: item.id, actionId: action.id });

  return {
    item: { id: item.id, deploymentStatus: DeploymentStatus.PENDING },
    actionId: action.id,
    validation,
    job: enqueueSummary(result),
  };
});
