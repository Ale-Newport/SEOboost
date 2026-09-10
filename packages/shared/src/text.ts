const STOP_WORDS = new Set([
  'a','about','above','after','again','all','am','an','and','any','are','as','at','be','because','been','before',
  'being','below','between','both','but','by','can','did','do','does','doing','down','during','each','few','for',
  'from','further','had','has','have','having','he','her','here','hers','him','his','how','i','if','in','into','is',
  'it','its','itself','just','me','more','most','my','no','nor','not','now','of','off','on','once','only','or',
  'other','our','ours','out','over','own','s','same','she','should','so','some','such','t','than','that','the',
  'their','theirs','them','then','there','these','they','this','those','through','to','too','under','until','up',
  'very','was','we','were','what','when','where','which','while','who','whom','why','will','with','you','your',
  'yours','el','la','los','las','de','del','y','que','en','un','una','por','para','con','se','su','al','lo','como',
]);

export function slugify(input: string, maxLength = 80): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) return slug || 'untitled';
  return slug.slice(0, maxLength).replace(/-[^-]*$/, '') || 'untitled';
}

export function normalizeKeyword(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text: string, opts: { stopWords?: boolean; minLength?: number } = {}): string[] {
  const { stopWords = true, minLength = 2 } = opts;
  const tokens = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= minLength);
  return stopWords ? tokens.filter((t) => !STOP_WORDS.has(t)) : tokens;
}

export function countWords(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡"'(])/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return 1;
  const cleaned = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const matches = cleaned.match(/[aeiouy]{1,2}/g);
  return Math.max(1, matches ? matches.length : 1);
}

/**
 * Flesch Reading Ease (0-100, higher = easier). Calibrated for English; for other
 * languages treat it as a rough structural proxy rather than a validated score.
 */
export function fleschReadingEase(text: string): number {
  const sentences = splitSentences(text);
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (sentences.length === 0 || words.length === 0) return 0;
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const score = 206.835 - 1.015 * (words.length / sentences.length) - 84.6 * (syllables / words.length);
  return Math.max(0, Math.min(100, Math.round(score * 10) / 10));
}

export function readabilityLabel(score: number): string {
  if (score >= 80) return 'Very easy';
  if (score >= 70) return 'Easy';
  if (score >= 60) return 'Plain English';
  if (score >= 50) return 'Fairly difficult';
  if (score >= 30) return 'Difficult';
  return 'Very difficult';
}

export function truncate(text: string, maxLength: number, suffix = '…'): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(0, maxLength - suffix.length)).trimEnd() + suffix;
}

/** Jaccard similarity over token sets — cheap lexical similarity, no embeddings needed. */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

/** Bag-of-words cosine similarity. Fallback when no embedding provider is configured. */
export function lexicalCosine(a: string, b: string): number {
  const tf = (text: string) => {
    const map = new Map<string, number>();
    for (const t of tokenize(text)) map.set(t, (map.get(t) ?? 0) + 1);
    return map;
  };
  const va = tf(a);
  const vb = tf(b);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, v] of va) na += v * v;
  for (const [t, v] of vb) {
    nb += v * v;
    const av = va.get(t);
    if (av) dot += av * v;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Does `text` contain `phrase` as a whole-word sequence? Accent- and case-insensitive. */
export function containsPhrase(text: string, phrase: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const needle = norm(phrase);
  if (!needle) return false;
  return ` ${norm(text)} `.includes(` ${needle} `);
}

/** Keyword density as a fraction (0-1) of total words. */
export function keywordDensity(text: string, keyword: string): number {
  const words = tokenize(text, { stopWords: false });
  if (words.length === 0) return 0;
  const kw = tokenize(keyword, { stopWords: false });
  if (kw.length === 0) return 0;
  let hits = 0;
  for (let i = 0; i + kw.length <= words.length; i++) {
    let match = true;
    for (let j = 0; j < kw.length; j++) {
      if (words[i + j] !== kw[j]) { match = false; break; }
    }
    if (match) hits++;
  }
  return (hits * kw.length) / words.length;
}

export function extractTopTerms(text: string, limit = 20): Array<{ term: string; count: number }> {
  const counts = new Map<string, number>();
  for (const t of tokenize(text)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** Strip markdown to plain prose for word counts and readability. */
export function markdownToText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractMarkdownHeadings(markdown: string): Array<{ level: number; text: string }> {
  const out: Array<{ level: number; text: string }> = [];
  const fenceRe = /```[\s\S]*?```/g;
  const body = markdown.replace(fenceRe, '');
  for (const line of body.split('\n')) {
    const m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (m && m[1] && m[2]) out.push({ level: m[1].length, text: m[2].replace(/#+\s*$/, '').trim() });
  }
  return out;
}

export { STOP_WORDS };
