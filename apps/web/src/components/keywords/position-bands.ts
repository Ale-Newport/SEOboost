/**
 * Ranking bands.
 *
 * The server turns a band id into `positionMin`/`positionMax`, the filter dropdown renders the
 * same ids with the facet counts, and the distribution chart uses the same edges — so a bar, a
 * chip and a row count can never disagree about what a band means.
 */

export interface PositionBand {
  id: PositionBandId;
  label: string;
  /** Inclusive lower bound. Omitted for the "not ranking" band. */
  min?: number;
  max?: number;
  /** Selects keywords with no recorded position at all. */
  unranked?: boolean;
  /** Bucket key used by `getKeywordFacets().positionBuckets`, when the band maps to one. */
  facetBucket?: string;
}

export type PositionBandId = 'top3' | '4-10' | '11-20' | '21-50' | '51plus' | 'unranked';

export const POSITION_BANDS: Record<PositionBandId, PositionBand> = {
  top3: { id: 'top3', label: 'Top 3', min: 1, max: 3, facetBucket: '1-3' },
  '4-10': { id: '4-10', label: '4 – 10', min: 4, max: 10, facetBucket: '4-10' },
  '11-20': { id: '11-20', label: '11 – 20', min: 11, max: 20, facetBucket: '11-20' },
  '21-50': { id: '21-50', label: '21 – 50', min: 21, max: 50, facetBucket: '21-50' },
  '51plus': { id: '51plus', label: '51+', min: 51, facetBucket: '51-100' },
  unranked: { id: 'unranked', label: 'Not ranking', unranked: true },
};

export function isPositionBandId(value: string): value is PositionBandId {
  return Object.hasOwn(POSITION_BANDS, value);
}

export const POSITION_BAND_LIST: readonly PositionBand[] = Object.values(POSITION_BANDS);

/** Striking distance: close enough to page one that focused on-page work can realistically move it. */
export const STRIKING_DISTANCE_BAND = { min: 8, max: 20 } as const;

/** The band a live position falls into, used to colour a rank in a table cell. */
export function bandForPosition(position: number | null | undefined): PositionBand {
  if (typeof position !== 'number' || !Number.isFinite(position)) return POSITION_BANDS.unranked;
  if (position <= 3) return POSITION_BANDS.top3;
  if (position <= 10) return POSITION_BANDS['4-10'];
  if (position <= 20) return POSITION_BANDS['11-20'];
  if (position <= 50) return POSITION_BANDS['21-50'];
  return POSITION_BANDS['51plus'];
}
