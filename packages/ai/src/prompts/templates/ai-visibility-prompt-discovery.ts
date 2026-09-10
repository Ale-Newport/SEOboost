import { registerPrompt } from '../registry';
import {
  ANALYSIS_RULES,
  OUTPUT_CONTRACT,
  bullets,
  lines,
  renderKnowledgeBase,
  section,
} from '../shared';
import type { PromptBrandFact, PromptKnowledgeBase } from '../shared';

export interface AiVisibilityPromptDiscoveryVars {
  siteName: string;
  domain: string;
  brandName?: string | null;
  businessCategory?: string | null;
  audience?: string | null;
  /** Keywords the site targets, as raw material for realistic assistant questions. */
  keywords?: readonly string[] | null;
  competitors?: readonly string[] | null;
  /** Prompts already tracked, so the set widens instead of repeating. */
  existingPrompts?: readonly string[] | null;
  count?: number | null;
  knowledgeBase?: PromptKnowledgeBase | null;
  brandFacts?: readonly PromptBrandFact[] | null;
}

export const aiVisibilityPromptDiscoveryPrompt = registerPrompt<AiVisibilityPromptDiscoveryVars>({
  id: 'ai-visibility-prompt-discovery',
  version: 1,
  description: 'Generate the assistant questions where this brand should appear, for tracking.',
  defaultRole: 'reasoning',
  system: lines(
    'You design the question set used to measure whether a brand shows up in AI assistant',
    'answers over time. These prompts become a tracked benchmark, so they must be realistic,',
    'stable and answerable.',
    '',
    'Write questions the way people actually talk to an assistant: full sentences, context',
    'included, often several constraints at once. They are not search keywords. "best crm" is a',
    'search query; "I run a 12-person agency and need a CRM that handles retainer billing —',
    'what should I look at?" is an assistant prompt.',
    '',
    'Cover these categories and label each prompt with one:',
    '- CATEGORY_DISCOVERY: "what tools do X", "how do people usually solve Y".',
    '- RECOMMENDATION: "what is the best X for Y", "what would you recommend for Z".',
    '- COMPARISON: "X vs Y", "alternatives to X", "is X or Y better for Z".',
    '- BRAND_DIRECT: "what is <brand>", "is <brand> any good", "who uses <brand>".',
    '- PROBLEM_SOLVING: the symptom described with no category name at all. These reveal',
    '  whether the brand is associated with the problem, which is the hardest visibility to win.',
    '- BUYING_PROCESS: pricing, migration, integration, procurement questions.',
    '- USE_CASE: a specific scenario the brand serves particularly well.',
    '',
    'For each prompt give: the text, the category, the buyer stage, why the brand should',
    'plausibly appear in a good answer, and which competitors would likely be named. Mark',
    'brandMentionExpected false when the brand realistically would not appear yet — those',
    'prompts are the most valuable to track, because they measure progress rather than flatter.',
    '',
    'Do not invent product capabilities to justify a prompt. If the knowledge base does not',
    'support the brand appearing for a scenario, do not fabricate a reason.',
    '',
    ANALYSIS_RULES,
    '',
    OUTPUT_CONTRACT,
  ),
  render: (vars) =>
    lines(
      renderKnowledgeBase(vars.knowledgeBase, vars.brandFacts),
      '',
      section(
        'Brand',
        lines(
          `Site: ${vars.siteName} (${vars.domain})`,
          vars.brandName ? `Brand name: ${vars.brandName}` : '',
          vars.businessCategory ? `Category: ${vars.businessCategory}` : '',
          vars.audience ? `Audience: ${vars.audience}` : '',
        ),
      ),
      section('Known competitors', bullets(vars.competitors)),
      section('Keywords the site targets', bullets(vars.keywords?.slice(0, 60))),
      section('Prompts already tracked — do not repeat these', bullets(vars.existingPrompts?.slice(0, 80))),
      `Produce ${vars.count ?? 25} prompts spread across the categories.`,
    ),
});
