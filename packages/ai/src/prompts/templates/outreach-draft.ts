import { registerPrompt } from '../registry';
import {
  OUTPUT_CONTRACT,
  QUALITY_RULES,
  clip,
  lines,
  renderKnowledgeBase,
  section,
} from '../shared';
import type { PromptBrandFact, PromptKnowledgeBase } from '../shared';

export interface OutreachDraftVars {
  /** Why we are writing: a broken link we can replace, a correction, a genuine resource offer. */
  reason: string;
  recipientSite: string;
  /** The specific page being written about — outreach without one is spam. */
  recipientPageUrl: string;
  recipientPageContext?: string | null;
  recipientName?: string | null;
  senderName: string;
  senderRole?: string | null;
  brandName: string;
  /** The resource being offered, and what makes it genuinely useful to that page. */
  ourResourceUrl?: string | null;
  ourResourceValue?: string | null;
  knowledgeBase?: PromptKnowledgeBase | null;
  brandFacts?: readonly PromptBrandFact[] | null;
}

export const outreachDraftPrompt = registerPrompt<OutreachDraftVars>({
  id: 'outreach-draft',
  version: 1,
  description: 'Draft one personalised outreach email for a human to review, edit and send.',
  defaultRole: 'writing',
  system: lines(
    'You draft a single outreach email about a single page, for a human to review, edit and',
    'send from their own mailbox.',
    '',
    'This is explicitly NOT mass outreach. There is no template with slots, no sequence, no',
    'follow-up cadence, and nothing here is ever sent automatically. If the supplied reason does',
    'not justify contacting this specific person about this specific page, say so in',
    '`recommendation` and return SKIP instead of writing an email. Refusing is the correct',
    'output far more often than people expect.',
    '',
    'A legitimate reason is one the recipient would agree with: a broken link on their page you',
    'can point to, a factual error you can correct, a resource that genuinely improves a page',
    'they clearly care about, or a data set they could cite. "We wrote a blog post" is not one.',
    '',
    'Craft:',
    '- subject: 4-8 words, specific to their page, no marketing language, no false urgency.',
    '- body: under 150 words. Open by referencing the specific thing on their page (accurately —',
    '  only use what you were given). State the reason in one sentence. Make the ask once, and',
    '  make it easy to say no. Sign off plainly.',
    '- No flattery, no "I loved your article", no fake familiarity, no "quick question" bait.',
    '- Never claim to have read something you were not shown, never invent a shared connection,',
    '  a statistic, a credential or a past interaction.',
    '- Never offer payment, a link exchange or any other incentive for a link.',
    '',
    'Also return: personalisationEvidence (the exact supplied detail the opening rests on),',
    'valueToRecipient in one sentence, and a recommendation of SEND_AFTER_REVIEW or SKIP with',
    'the reason. Every draft requires human review before it is sent; state that assumption.',
    '',
    QUALITY_RULES,
    '',
    OUTPUT_CONTRACT,
  ),
  render: (vars) =>
    lines(
      renderKnowledgeBase(vars.knowledgeBase, vars.brandFacts),
      '',
      section(
        'Sender',
        lines(
          `${vars.senderName}${vars.senderRole ? `, ${vars.senderRole}` : ''}`,
          `Brand: ${vars.brandName}`,
        ),
      ),
      section(
        'Recipient',
        lines(
          vars.recipientName ? `Name: ${vars.recipientName}` : 'Name: unknown — do not guess one',
          `Site: ${vars.recipientSite}`,
          `Page in question: ${vars.recipientPageUrl}`,
        ),
      ),
      section('What we know about their page', clip(vars.recipientPageContext, 3000)),
      section('Reason for contact', vars.reason),
      section(
        'What we are offering',
        lines(
          vars.ourResourceUrl ? `Resource: ${vars.ourResourceUrl}` : '',
          vars.ourResourceValue ? `Why it helps their page: ${vars.ourResourceValue}` : '',
        ),
      ),
      'Draft the email, or return SKIP with the reason.',
    ),
});
