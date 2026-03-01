/**
 * Keyword bucket scanner.
 * Uses Statbot keyword endpoint if available; otherwise returns null
 * (section is omitted from the report gracefully).
 */

import { getKeywords } from '../api/statbot';
import { KEYWORD_BUCKETS } from '../config';
import { logger } from '../logger';

export interface BucketResult {
  bucket: string;
  count:  number;
  topKeywords: string[];
}

/**
 * Fetch keyword data from Statbot and map to configured keyword buckets.
 * Returns null if the endpoint is unavailable.
 */
export async function getKeywordBuckets(from: Date, to: Date): Promise<BucketResult[] | null> {
  const keywords = await getKeywords(from, to);
  if (!keywords) {
    logger.warn('[keywords] Statbot keyword endpoint unavailable — omitting section');
    return null;
  }

  // Build a map: keyword → count (case-insensitive)
  const kwMap = new Map<string, number>();
  for (const { keyword, count } of keywords) {
    kwMap.set(keyword.toLowerCase(), count);
  }

  const results: BucketResult[] = [];
  for (const [bucket, terms] of Object.entries(KEYWORD_BUCKETS)) {
    let total = 0;
    const matched: string[] = [];
    for (const term of terms) {
      const c = kwMap.get(term.toLowerCase()) ?? 0;
      if (c > 0) {
        total += c;
        matched.push(`${term} (${c})`);
      }
    }
    if (total > 0) {
      results.push({ bucket, count: total, topKeywords: matched.slice(0, 5) });
    }
  }

  // Sort by hit count descending
  results.sort((a, b) => b.count - a.count);
  logger.info(`[keywords] Bucketed ${results.length} active keyword categories`);
  return results;
}
