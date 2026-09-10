import { z } from 'zod';
import { SchemaValidationStatus, json, prisma } from '@seo/db';
import { ValidationError } from '@seo/shared';
import { parseJsonLd, validateJsonLd } from '@seo/seo-engine';
import { readBody, requireWebsite, route } from '@/lib/api';

/**
 * `POST /api/schema/validate` — validate arbitrary JSON-LD pasted into the UI.
 *
 * Pure by default: nothing is stored unless the caller names an existing item to update, which
 * makes this safe to call on every keystroke in the editor. Accepts either a parsed object
 * (`jsonLd`) or the raw string from the textarea (`raw`), because a paste is usually a string
 * with its own syntax errors worth reporting separately from its schema errors.
 */

const bodySchema = z
  .object({
    jsonLd: z.unknown().optional(),
    raw: z.string().max(500_000).optional(),
    /** Persist the outcome onto this StructuredDataItem. Requires websiteId. */
    itemId: z.string().trim().min(1).optional(),
    websiteId: z.string().trim().min(1).optional(),
  })
  .refine((value) => value.jsonLd !== undefined || value.raw !== undefined, {
    message: 'Provide either jsonLd or raw.',
  })
  .refine((value) => !value.itemId || Boolean(value.websiteId), {
    message: 'websiteId is required when itemId is given.',
  });

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);

  let parsed: unknown = body.jsonLd;
  let parseError: string | null = null;

  if (body.raw !== undefined) {
    const result = parseJsonLd(body.raw);
    parsed = result.data;
    parseError = result.error;
  }

  if (parseError) {
    return {
      status: 'INVALID' as const,
      types: [],
      issues: [{ severity: 'error' as const, path: '$', message: parseError }],
      parseError,
      stored: false,
    };
  }

  const validation = validateJsonLd(parsed);

  if (!body.itemId || !body.websiteId) {
    return { ...validation, parseError: null, stored: false };
  }

  const website = await requireWebsite(user.id, body.websiteId);
  const item = await prisma.structuredDataItem.findFirst({
    where: { id: body.itemId, websiteId: website.id },
    select: { id: true },
  });
  if (!item) throw new ValidationError('That structured data item does not belong to this website.');

  const status =
    validation.status === 'VALID'
      ? SchemaValidationStatus.VALID
      : validation.status === 'WARNING'
        ? SchemaValidationStatus.WARNING
        : SchemaValidationStatus.INVALID;

  await prisma.structuredDataItem.update({
    where: { id: item.id },
    data: {
      // Storing the markup alongside its verdict keeps the row self-consistent: a status that
      // describes different JSON than the row holds is worse than no status at all.
      ...(parsed === undefined ? {} : { jsonLd: json(parsed) }),
      validationStatus: status,
      validationErrors: json(validation.issues),
    },
  });

  return { ...validation, parseError: null, stored: true, itemId: item.id };
});
