/**
 * Weekly Community Pulse Summary
 * Every Monday at 12:00 CET it pulls the last 7 daily Community Pulse reports
 * from the DB, sends the digest to OpenAI, and posts a ranked top-5/6 theme
 * summary to the staff channel.
 *
 * No raw messages are re-analysed — this synthesises already-saved daily results,
 * so it costs one lightweight AI call per week (~$0.01).
 */

import { EmbedBuilder } from 'discord.js';
import { logger } from '../logger';
import { getSetting } from '../store/settingsDb';
import { getSentimentReports } from '../store/db';
import { postDailyReport } from '../api/discord';
import { getWeeklySummary, PulseResult } from '../api/openai';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildMoodBar(score: number): string {
  const filled = Math.max(1, Math.min(5, Math.round(score)));
  return '█'.repeat(filled) + '░'.repeat(5 - filled);
}

// ── Main ─────────────────────────────────────────────────────────────────────

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

  // 5. AI synthesis
  const summary = await getWeeklySummary(digest, parsed.length);
  if (!summary) {
    logger.error('[weeklyPulse] AI synthesis failed — aborting');
    return;
  }

  // 6. Build Discord embed
  const from      = parsed[0].date;
  const to        = parsed[parsed.length - 1].date;
  const moodColor = avgMood >= 4 ? 0x2ecc71 : avgMood <= 2 ? 0xe74c3c : 0x9b59b6;
  const moodBar   = buildMoodBar(avgMood);

  const topicsText = summary.top_topics
    .slice(0, 6)
    .map((t, i) => {
      const dayTag = t.days_mentioned > 1
        ? ` *(${t.days_mentioned}/${parsed.length}d${t.recurring ? ' 🔴' : ''})* `
        : ' ';
      return `**${i + 1}. ${t.topic}**${dayTag}\n${t.summary}`;
    })
    .join('\n\n');

  const embed = new EmbedBuilder()
    .setTitle(`📋 Weekly Community Pulse — ${from} → ${to}`)
    .setColor(moodColor)
    .setDescription(
      `Based on **${parsed.length} daily reports**. Avg mood: ${moodBar} **${avgMood.toFixed(1)}/5**\n\n` +
      `*${summary.week_mood}*`,
    )
    .addFields({ name: '🏆 Top Topics This Week', value: topicsText || '_No data_', inline: false });

  if (summary.trending) {
    embed.addFields({ name: '📈 Most Trending', value: summary.trending, inline: false });
  }

  embed
    .setFooter({ text: `WoWS Community Reports · Weekly Pulse · ${from} → ${to}` })
    .setTimestamp();

  await postDailyReport(embed);
  logger.info(`[weeklyPulse] Weekly summary posted for ${from} → ${to}`);
}
