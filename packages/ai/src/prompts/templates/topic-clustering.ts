import { registerPrompt } from '../registry';
import { ANALYSIS_RULES, OUTPUT_CONTRACT, lines, section } from '../shared';

export interface TopicClusteringKeyword {
  keyword: string;
  intent?: string | null;
  volume?: number | null;
  /** URL currently ranking for the term, when known — a strong same-page signal. */
  rankingUrl?: string | null;
}

export interface TopicClusteringVars {
  siteName: string;
  keywords: readonly TopicClusteringKeyword[];
  /** Clusters that already exist, so the model extends the taxonomy instead of replacing it. */
  existingClusters?: readonly string[] | null;
  maxClusters?: number | null;
}

export const topicClusteringPrompt = registerPrompt<TopicClusteringVars>({
  id: 'topic-clustering',
  version: 1,
  description: 'Group keywords into topic clusters with a pillar page and supporting pages.',
  defaultRole: 'reasoning',
  system: lines(
    'You are an information architect who turns a flat keyword list into a site structure.',
    '',
    'The unit of clustering is the PAGE, not the theme. Two keywords belong together only if',
    'one page can satisfy both searchers completely. Ask: would a searcher for keyword A be',
    'happy landing on the page built for keyword B? If not, they are separate pages even when',
    'the words overlap. This is what prevents the clusters from causing cannibalisation later.',
    '',
    'For each cluster produce:',
    '- name: the topic in human words, not a keyword string.',
    '- pillarKeyword: the term the main page should target — usually the broadest one the site',
    '  can realistically win, not simply the highest volume.',
    '- supportingKeywords: terms the same page should also cover (variants, subquestions).',
    '- spinOffKeywords: terms that clearly deserve their own page instead, with a one-line',
    '  reason. Being explicit here is more valuable than forcing them into the cluster.',
    '- contentType: the format the pillar page should take.',
    '- intent and funnelStage for the cluster as a whole.',
    '- priority 0-1: business value multiplied by realistic winnability, with a rationale.',
    '- internalLinkingNote: how this cluster should link to the others you created.',
    '',
    'Rules:',
    '- Every input keyword must appear in exactly one cluster (as pillar, supporting or',
    '  spin-off). Do not drop keywords, and do not duplicate them across clusters.',
    '- Reuse an existing cluster name when a keyword belongs to one; only create new clusters',
    '  for genuinely new territory.',
    '- Do not invent search volumes or difficulty scores.',
    '',
    ANALYSIS_RULES,
    '',
    OUTPUT_CONTRACT,
  ),
  render: (vars) =>
    lines(
      section('Site', vars.siteName),
      section(
        'Existing clusters — reuse these names where they fit',
        vars.existingClusters?.length ? vars.existingClusters.map((name) => `- ${name}`).join('\n') : '',
      ),
      section(
        'Keywords to cluster',
        vars.keywords
          .map((entry) => {
            const meta = [
              entry.intent ? `intent ${entry.intent}` : '',
              entry.volume !== null && entry.volume !== undefined ? `volume ${entry.volume}` : '',
              entry.rankingUrl ? `ranks: ${entry.rankingUrl}` : '',
            ]
              .filter(Boolean)
              .join(', ');
            return `- "${entry.keyword}"${meta ? ` (${meta})` : ''}`;
          })
          .join('\n'),
      ),
      `Create at most ${vars.maxClusters ?? 20} clusters. Account for every keyword listed above.`,
    ),
});
