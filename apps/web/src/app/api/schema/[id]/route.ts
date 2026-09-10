import { DeploymentStatus, prisma } from '@seo/db';
import { ConflictError, NotFoundError } from '@seo/shared';
import { requireWebsite, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';

/**
 * `DELETE /api/schema/[id]` — remove one structured data item from the workspace.
 *
 * Deleting the row removes *our record* of the markup. It does not retract markup already
 * deployed to a live page, so a deployed item comes back with an explicit warning instead of
 * letting the operator believe the page was cleaned up. A queued deployment is refused
 * outright: the `SeoAction` it created points at this row, and deleting it underneath the
 * worker turns a clear "deploy" into an opaque job failure.
 */
export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  await assertNotReadOnly();

  const item = await prisma.structuredDataItem.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      websiteId: true,
      schemaType: true,
      deploymentStatus: true,
      page: { select: { url: true } },
    },
  });
  if (!item) throw new NotFoundError('Structured data item');
  await requireWebsite(user.id, item.websiteId);

  if (item.deploymentStatus === DeploymentStatus.PENDING) {
    throw new ConflictError(
      'A deployment for this item is still queued. Wait for it to finish (or cancel the job on the Jobs screen) before deleting it.',
    );
  }

  await prisma.structuredDataItem.delete({ where: { id: item.id } });

  return {
    deleted: item.id,
    schemaType: item.schemaType,
    warning:
      item.deploymentStatus === DeploymentStatus.DEPLOYED
        ? `This ${item.schemaType} block was already deployed${item.page ? ` to ${item.page.url}` : ''}. ` +
          'Removing it here deletes our record only — take the <script type="application/ld+json"> tag off the ' +
          'page itself to remove it from the live site.'
        : null,
  };
});
