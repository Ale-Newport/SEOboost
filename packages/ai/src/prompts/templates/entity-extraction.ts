import { registerPrompt } from '../registry';
import { ANALYSIS_RULES, GEO_PRINCIPLES, OUTPUT_CONTRACT, clip, lines, section } from '../shared';

export interface EntityExtractionVars {
  content: string;
  url?: string | null;
  title?: string | null;
  /** The brand itself, so its own mentions are classified rather than treated as third-party. */
  brandName?: string | null;
  targetKeyword?: string | null;
}

export const entityExtractionPrompt = registerPrompt<EntityExtractionVars>({
  id: 'entity-extraction',
  version: 1,
  description: 'Extract the entities a page establishes, for knowledge-graph and GEO analysis.',
  defaultRole: 'fast',
  system: lines(
    'You extract entities from a page the way a knowledge graph would.',
    '',
    'Entities are the nouns a machine can resolve to a thing in the world: organisations,',
    'people, products, technologies, standards, locations, events, regulations, methods and',
    'well-defined concepts. Adjectives, generic categories and marketing phrases are not',
    'entities, and including them dilutes every downstream comparison.',
    '',
    'For each entity return:',
    '- name: the canonical form, as the world names it (not the page\'s stylisation).',
    '- type: ORGANIZATION, PERSON, PRODUCT, TECHNOLOGY, STANDARD, LOCATION, EVENT, CONCEPT,',
    '  REGULATION, METRIC or OTHER.',
    '- mentions: how many times it appears, and the surface forms used.',
    '- salience 0-1: how central it is to what this page is about. The page can only be',
    '  "about" two or three entities; be strict.',
    '- role: SUBJECT (the page is about it), SUPPORTING (used to explain the subject),',
    '  COMPETITOR, CUSTOMER, TOOL or PASSING.',
    '- definedOnPage: whether the page actually explains what it is. An entity used without',
    '  definition is a comprehension gap for both readers and answer engines.',
    '- linkedTo: the URL the page links it to, or null. External links to authoritative',
    '  definitions strengthen entity association.',
    '',
    'Also report:',
    '- primaryEntity: the single entity this page is about, with confidence.',
    '- entityGaps: entities a complete treatment of this topic would name and this page does',
    '  not. Only list ones you can justify from the page\'s own subject matter.',
    '- ambiguities: entities whose reference is unclear (pronouns, "the platform", "the tool"),',
    '  which weaken machine understanding.',
    '',
    'Extract only what is present. Never add an entity because it would be good for SEO, and',
    'never resolve an abbreviation to a specific company unless the page makes that clear.',
    '',
    GEO_PRINCIPLES,
    '',
    ANALYSIS_RULES,
    '',
    OUTPUT_CONTRACT,
  ),
  render: (vars) =>
    lines(
      section(
        'Page',
        lines(
          vars.url ? `URL: ${vars.url}` : '',
          vars.title ? `Title: ${vars.title}` : '',
          vars.brandName ? `This site belongs to: ${vars.brandName}` : '',
          vars.targetKeyword ? `Target keyword: "${vars.targetKeyword}"` : '',
        ),
      ),
      section('Content', clip(vars.content, 40000)),
      'Extract the entities.',
    ),
});
