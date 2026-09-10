import { type Prisma, json, prisma, readJson } from '@seo/db';
import { createLogger, knowledgeBaseSchema } from '@seo/shared';
import { readBody, requireWebsite, route } from '@/lib/api';

const log = createLogger('api:knowledge-base');

type Params = { id: string };

interface ProductEntry {
  name: string;
  description?: string;
  url?: string;
}
interface TerminologyEntry {
  term: string;
  definition: string;
}
interface AuthorEntry {
  name: string;
  title?: string;
  bio?: string;
  url?: string;
}

/**
 * The per-site knowledge base: the only facts the content agents may write from.
 *
 * Author bios live here because they must describe *real* people the operator vouches for —
 * the content pipeline is not allowed to invent a byline, so if this list is empty the drafts
 * simply carry no author rather than a plausible-sounding fabrication.
 */
export const GET = route<Params>(async ({ user, params }) => {
  await requireWebsite(user.id, params.id);

  const record = await prisma.knowledgeBase.findUnique({ where: { websiteId: params.id } });
  if (!record) {
    // Nothing has been filled in yet. An empty shell keeps the form simple and says so.
    return {
      knowledgeBase: null,
      isEmpty: true,
      completeness: 0,
    };
  }

  const products = readJson<ProductEntry[]>(record.products, []);
  const terminology = readJson<TerminologyEntry[]>(record.terminology, []);
  const authorBios = readJson<AuthorEntry[]>(record.authorBios, []);

  // Completeness is a plain count of filled sections — no weighting, nothing inferred.
  const sections = [
    Boolean(record.businessDescription),
    Boolean(record.audience),
    Boolean(record.toneOfVoice),
    Boolean(record.brandStyle),
    Boolean(record.preferredCta),
    Boolean(record.writingGuidelines),
    record.uniqueValueProps.length > 0,
    record.prohibitedClaims.length > 0,
    products.length > 0,
    terminology.length > 0,
    authorBios.length > 0,
  ];

  return {
    knowledgeBase: { ...record, products, terminology, authorBios },
    isEmpty: sections.every((filled) => !filled),
    completeness: Math.round((sections.filter(Boolean).length / sections.length) * 100),
  };
});

/**
 * Replace the knowledge base.
 *
 * PUT rather than PATCH because the client edits the whole document at once; fields left out of
 * the body are cleared, which is what "remove this product" has to mean for a form like this.
 */
export const PUT = route<Params>(async ({ user, request, params }) => {
  await requireWebsite(user.id, params.id);
  const input = await readBody(request, knowledgeBaseSchema);

  const payload = {
    businessDescription: input.businessDescription ?? null,
    audience: input.audience ?? null,
    toneOfVoice: input.toneOfVoice ?? null,
    brandStyle: input.brandStyle ?? null,
    preferredCta: input.preferredCta ?? null,
    writingGuidelines: input.writingGuidelines ?? null,
    prohibitedClaims: input.prohibitedClaims ?? [],
    uniqueValueProps: input.uniqueValueProps ?? [],
    products: json(input.products ?? []),
    terminology: json(input.terminology ?? []),
    authorBios: json(input.authorBios ?? []),
  } satisfies Prisma.KnowledgeBaseUncheckedUpdateInput;

  const knowledgeBase = await prisma.knowledgeBase.upsert({
    where: { websiteId: params.id },
    create: { websiteId: params.id, ...payload },
    update: payload,
  });

  log.info('knowledge base saved', { websiteId: params.id });
  return { knowledgeBase };
});
