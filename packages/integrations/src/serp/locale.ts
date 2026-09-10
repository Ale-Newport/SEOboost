/**
 * Locale handling for SERP providers.
 *
 * The schema stores locales as BCP-47 (`en-US`) but country columns as ISO 3166-1 alpha-3
 * (`USA`). Providers want language + alpha-2, so every client funnels through `parseLocale`
 * to avoid three slightly different parsers drifting apart.
 */

export const DEFAULT_LOCALE = 'en-US';

export interface ParsedLocale {
  /** ISO 639-1, lowercase (`en`). */
  language: string;
  /** ISO 3166-1 alpha-2, uppercase (`US`). */
  country: string;
  /** Canonical `language-COUNTRY` form. */
  locale: string;
}

/** Alpha-3 → alpha-2 for the countries the product ships country pickers for. */
const ALPHA3_TO_ALPHA2: Record<string, string> = {
  USA: 'US', GBR: 'GB', CAN: 'CA', AUS: 'AU', NZL: 'NZ', IRL: 'IE', ZAF: 'ZA',
  DEU: 'DE', AUT: 'AT', CHE: 'CH', FRA: 'FR', BEL: 'BE', NLD: 'NL', LUX: 'LU',
  ESP: 'ES', PRT: 'PT', ITA: 'IT', GRC: 'GR', POL: 'PL', CZE: 'CZ', SVK: 'SK',
  HUN: 'HU', ROU: 'RO', BGR: 'BG', HRV: 'HR', SVN: 'SI', SWE: 'SE', NOR: 'NO',
  DNK: 'DK', FIN: 'FI', ISL: 'IS', EST: 'EE', LVA: 'LV', LTU: 'LT', UKR: 'UA',
  RUS: 'RU', TUR: 'TR', ISR: 'IL', ARE: 'AE', SAU: 'SA', EGY: 'EG', NGA: 'NG',
  KEN: 'KE', IND: 'IN', PAK: 'PK', BGD: 'BD', LKA: 'LK', CHN: 'CN', HKG: 'HK',
  TWN: 'TW', JPN: 'JP', KOR: 'KR', SGP: 'SG', MYS: 'MY', IDN: 'ID', THA: 'TH',
  VNM: 'VN', PHL: 'PH', BRA: 'BR', ARG: 'AR', CHL: 'CL', COL: 'CO', PER: 'PE',
  MEX: 'MX', URY: 'UY', VEN: 'VE', ECU: 'EC',
};

/** Fallback country when a bare language is given (`en` → `en-US`, `de` → `de-DE`). */
const LANGUAGE_DEFAULT_COUNTRY: Record<string, string> = {
  en: 'US', de: 'DE', fr: 'FR', es: 'ES', it: 'IT', pt: 'BR', nl: 'NL', sv: 'SE',
  no: 'NO', da: 'DK', fi: 'FI', pl: 'PL', cs: 'CZ', sk: 'SK', hu: 'HU', ro: 'RO',
  bg: 'BG', el: 'GR', tr: 'TR', ru: 'RU', uk: 'UA', ar: 'AE', he: 'IL', hi: 'IN',
  zh: 'CN', ja: 'JP', ko: 'KR', th: 'TH', vi: 'VN', id: 'ID', ms: 'MY',
};

/** Normalise an alpha-2/alpha-3 country code to alpha-2; returns undefined if unrecognised. */
export function toAlpha2(country: string | undefined): string | undefined {
  if (!country) return undefined;
  const c = country.trim().toUpperCase();
  if (c.length === 2) return c;
  return ALPHA3_TO_ALPHA2[c];
}

/**
 * Parse `en-US`, `en_us`, `en` or `USA` into language + alpha-2 country.
 * Unparseable input falls back to the default locale rather than throwing — a bad locale
 * must not take a whole SERP job down.
 */
export function parseLocale(input?: string | null, fallback: string = DEFAULT_LOCALE): ParsedLocale {
  const raw = (input ?? '').trim();
  const source = raw === '' ? fallback : raw;
  const parts = source.split(/[-_]/).filter(Boolean);

  let language = (parts[0] ?? 'en').toLowerCase();
  let country = toAlpha2(parts[1]);

  // A bare country code (`USA`) was passed where a locale was expected.
  if (parts.length === 1 && (language.length === 3 || language.length === 2)) {
    const asCountry = toAlpha2(parts[0]);
    if (asCountry && !LANGUAGE_DEFAULT_COUNTRY[language]) {
      country = asCountry;
      language = 'en';
    }
  }

  if (language.length !== 2) language = 'en';
  if (!country) country = LANGUAGE_DEFAULT_COUNTRY[language] ?? 'US';

  return { language, country, locale: `${language}-${country}` };
}
