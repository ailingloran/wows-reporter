/**
 * Formatting helpers shared by daily and monthly report builders.
 */

/** Format a number with thousands separators (e.g. 1234567 → "1,234,567"). */
export function formatNumber(n: number | null | undefined): string {
  if (n == null) return 'N/A';
  return n.toLocaleString('en-US');
}

/** Format a Date as "Mon DD YYYY" (e.g. "Jan 21 2026"). */
export function formatDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Format a Date as "MMMM YYYY" (e.g. "January 2026"). */
export function formatMonthYear(d: Date): string {
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

/** Format a percentage to one decimal place. */
export function formatPct(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

export interface DeltaResult {
  arrow:   string;   // 🔼 | 🔽 | ➡️
  sign:    string;   // + | - | ''
  text:    string;   // e.g. "+156 🔼 +14.4%"
  isGood:  boolean;
}

/**
 * Compute a delta between current and previous value.
 * @param current   Current period value
 * @param previous  Previous period value
 * @param lowerIsBetter  Set true for metrics where a decrease is positive (e.g. leaves)
 */
export function computeDelta(
  current:  number | null,
  previous: number | null,
  lowerIsBetter = false,
): DeltaResult {
  if (current == null || previous == null) {
    return { arrow: '➡️', sign: '', text: 'No comparison data', isGood: true };
  }

  const diff = current - previous;
  const pct  = previous !== 0 ? (diff / previous) * 100 : 0;

  let arrow:  string;
  let isGood: boolean;

  if (diff > 0)       { arrow = '🔼'; isGood = !lowerIsBetter; }
  else if (diff < 0)  { arrow = '🔽'; isGood = lowerIsBetter; }
  else                { arrow = '➡️'; isGood = true; }

  const sign = diff >= 0 ? '+' : '';
  const text = `${sign}${formatNumber(diff)} ${arrow} ${formatPct(pct)}`;
  return { arrow, sign, text, isGood };
}

/** Return top N items from an array sorted by a numeric key descending. */
export function topN<T>(arr: T[], key: keyof T, n: number): T[] {
  return [...arr]
    .sort((a, b) => (b[key] as unknown as number) - (a[key] as unknown as number))
    .slice(0, n);
}

/** Build the hotspot channels text block for embeds. */
export function buildHotspotText(
  channels: Array<{ channel_name: string; messages: number }>,
  totalMessages: number | null,
  n = 3,
): string {
  if (!channels.length) return '_No channel data_';
  const top = channels.slice(0, n);
  return top.map((ch, i) => {
    const pct = totalMessages ? ((ch.messages / totalMessages) * 100).toFixed(1) : '?';
    return `**${i + 1}.** #${ch.channel_name} — ${formatNumber(ch.messages)} msgs (${pct}%)`;
  }).join('\n');
}
