/**
 * Weekly Community Pulse Summary
 * Every Monday at 12:00 CET it pulls the last 7 daily Community Pulse reports,
 * synthesises them with gpt-5.1 (one AI call per week, ~$0.01), and saves the
 * result to the weekly_pulse_reports table for display in the dashboard.
 *
 * No Discord embed — dashboard only.
 */

import { logger } from '../logger';
import { getSentimentReports, insertWeeklyPulse } from '../store/db';
import { getWeeklySummary, PulseResult } from '../api/openai';

export async function runWeeklyPulseSummary(): Promise<void> {
  // 1. Fetch last 7 daily reports (most-recent first from DB)
  const rawReports = getSentimentReports(7);

  if (rawReports.length < 2) {
    logger.warn('[weeklyPulse] Not enough daily reports (need ≥2) — skipping');
    return;
  }

  // 2. Parse JSON — reverse so we go oldest → newest for the digest
  type ParsedDay = { date: string; result: PulseResult; moodScore: number };
  const parsed: ParsedDay[] = [];

  for (const row of [...rawReports].reverse()) {
    if (!row.raw_json) continue;
    try {
      const result = JSON.parse(row.raw_json) as PulseResult;
      parsed.push({
        date: row.taken_at.slice(0, 10),
        result,
        moodScore: typeof result.mood_score === 'number' ? result.mood_score : 3,
      });
    } catch {
      logger.warn(`[weeklyPulse] Failed to parse report taken_at=${row.taken_at}`);
    }
  }

  if (parsed.length < 2) {
    logger.warn('[weeklyPulse] Not enough parseable reports — skipping');
    return;
  }

  // 3. Average mood score across the week
  const avgMood = parsed.reduce((s, r) => s + r.moodScore, 0) / parsed.length;

  // 4. Build a structured day-by-day digest for the AI
  const digest = parsed
    .map(r => {
      const topics    = r.result.topics?.map(t => `  • ${t.text}`).join('\n') || '  (none)';
      const pains     = r.result.pain_points?.map(p => `  • ${p.text}`).join('\n') || '  (none)';
      const positives = r.result.positives?.map(p => `  • ${p.text}`).join('\n') || '  (none)';
      return (
        `[${r.date}] Mood: ${r.moodScore}/5  Trending: ${r.result.trending ?? '—'}\n` +
        `Topics:\n${topics}\nPain points:\n${pains}\nPositives:\n${positives}`
      );
    })
    .join('\n\n---\n\n');

  // 5. AI synthesis via gpt-5.1
  const summary = await getWeeklySummary(digest, parsed.length);
  if (!summary) {
    logger.error('[weeklyPulse] AI synthesis failed — aborting');
    return;
  }

  // 6. Persist to DB for dashboard display
  const from = parsed[0].date;
  const to   = parsed[parsed.length - 1].date;
  insertWeeklyPulse(from, to, parsed.length, avgMood, JSON.stringify(summary));

  logger.info(`[weeklyPulse] Weekly summary saved for ${from} → ${to}`);
}
