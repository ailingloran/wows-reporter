/**
 * Community Pulse Report
 * Collects recent messages, analyses them with OpenAI, and posts a
 * structured sentiment summary embed to the staff channel.
 * Runs independently at 17:00 CET — existing reports are unaffected.
 */

import { EmbedBuilder } from 'discord.js';
import { config } from '../config';
import { logger } from '../logger';
import { queryIndexedMessages } from '../store/messageDb';
import { getSetting } from '../store/settingsDb';
import { collectRecentMessages } from '../collectors/messageCollector';
import { analyseCommunityPulse, PulseItem, PulseResult } from '../api/openai';
import { postDailyReport } from '../api/discord';
import { getSentimentReports, insertSentimentReport, SentimentReportRow } from '../store/db';
import { formatDate } from './formatters';

export type SentimentSource = 'db' | 'live';

// ── Delta computation helpers ─────────────────────────────────────────────────

// Words to ignore when matching pain points across reports
const DELTA_IGNORE = new Set([
  'players', 'player', 'about', 'their', 'with', 'from', 'this', 'that',
  'have', 'been', 'were', 'are', 'the', 'and', 'for', 'discussing',
  'mentioned', 'saying', 'said', 'game', 'community', 'channel', 'they',
  'very', 'more', 'some', 'most', 'many', 'when', 'which', 'that',
]);

function extractSignificantWords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 4 && !DELTA_IGNORE.has(w)),
    ),
  ];
}

/**
 * For each pain_point in the current report, check if the same theme appeared
 * in any of the previous reports. Sets recurring=true and first_seen_days_ago
 * if at least 2 significant words overlap with a previous pain_point text.
 */
function markRecurring(currentItems: PulseItem[], previousReports: SentimentReportRow[]): void {
  // Build list of {text, date} from previous pain_points
  const prevPains: { words: string[]; takenAt: string }[] = [];
  for (const report of previousReports) {
    if (!report.raw_json) continue;
    try {
      const parsed = JSON.parse(report.raw_json) as Partial<PulseResult>;
      if (!Array.isArray(parsed.pain_points)) continue;
      for (const pp of parsed.pain_points) {
        if (pp?.text) {
          prevPains.push({ words: extractSignificantWords(pp.text), takenAt: report.taken_at });
        }
      }
    } catch { /* skip malformed */ }
  }

  for (const item of currentItems) {
    const currentWords = extractSignificantWords(item.text);
    let bestDaysAgo: number | null = null;

    for (const prev of prevPains) {
      const overlap = currentWords.filter(w => prev.words.includes(w)).length;
      if (overlap >= 2) {
        const daysAgo = Math.round((Date.now() - new Date(prev.takenAt).getTime()) / 86_400_000);
        if (bestDaysAgo === null || daysAgo > bestDaysAgo) {
          bestDaysAgo = daysAgo;
        }
      }
    }

    item.recurring = bestDaysAgo !== null;
    item.first_seen_days_ago = bestDaysAgo;
  }
}

// ── Citation enrichment ───────────────────────────────────────────────────────

/**
 * Build a citations map: 1-based message index → message content.
 *
 * Only stores a citation if the cited message contains at least one significant
 * word from the item's text. This filters out GPT hallucinated indices where
 * the cited message is unrelated to the topic it supposedly supports.
 */
function buildCitations(pulse: PulseResult, messages: string[]): Record<number, string> {
  const citations: Record<number, string> = {};

  const allItems: PulseItem[] = [
    ...pulse.topics,
    ...pulse.pain_points,
    ...pulse.positives,
  ];

  for (const item of allItems) {
    const itemWords = extractSignificantWords(item.text);
    const seenIdx = new Set<number>();

    for (const idx of item.msgs) {
      if (seenIdx.has(idx)) continue; // skip duplicate indices from GPT
      seenIdx.add(idx);

      const msg = messages[idx - 1]; // msgs are 1-based
      if (!msg) continue;

      // Only keep the citation if the message content shares at least one
      // significant word with the item. Filters irrelevant GPT hallucinations.
      const msgLower = msg.toLowerCase();
      if (itemWords.length === 0 || itemWords.some(w => msgLower.includes(w))) {
        citations[idx] = msg;
      }
    }
  }

  return citations;
}

// ── Main report ───────────────────────────────────────────────────────────────

export async function runSentimentReport(source: SentimentSource = 'db'): Promise<void> {
  // ── Precondition checks ────────────────────────────────────────────────────
  if (!config.openAiApiKey) {
    logger.warn('[sentiment] OPENAI_API_KEY not set — Community Pulse report skipped');
    return;
  }
  // Read channels + limit from settings DB (falls back to env var defaults)
  const channelIds = getSetting('sentiment_channel_ids', config.sentimentChannelIds.join(','))
    .split(',').map(s => s.trim()).filter(Boolean);
  const messageLimit = parseInt(
    getSetting('sentiment_message_limit', String(config.sentimentMessageLimit)), 10,
  );

  if (channelIds.length === 0) {
    logger.warn('[sentiment] No sentiment channels configured — Community Pulse report skipped');
    return;
  }

  logger.info(`[sentiment] Starting Community Pulse report (source: ${source})...`);

  // ── Collect messages ───────────────────────────────────────────────────────
  const messages = source === 'live'
    ? await collectRecentMessages(channelIds)
    : queryIndexedMessages(24, channelIds, messageLimit, []);

  if (messages.length < 10) {
    logger.warn(`[sentiment] Only ${messages.length} messages found — not enough data, skipping`);
    return;
  }

  // ── Analyse with OpenAI ────────────────────────────────────────────────────
  const pulse = await analyseCommunityPulse(messages);
  if (!pulse) {
    logger.error('[sentiment] OpenAI analysis failed — Community Pulse report not posted');
    return;
  }

  // ── Enrich: citations ──────────────────────────────────────────────────────
  pulse.citations = buildCitations(pulse, messages);

  // ── Enrich: delta (mark recurring pain points) ─────────────────────────────
  // Load last 3 reports (excluding the one we're about to insert)
  const previousReports = getSentimentReports(3);
  markRecurring(pulse.pain_points, previousReports);

  // ── Persist to DB ──────────────────────────────────────────────────────────
  const takenAt = new Date().toISOString();
  insertSentimentReport(takenAt, pulse.mood, JSON.stringify(pulse));

  // ── Build embed ────────────────────────────────────────────────────────────
  const today = formatDate(new Date());

  function formatItem(item: PulseItem, showRecurring = false): string {
    const authorsNote = item.authors > 1 ? ` *(${item.authors} players)*` : '';
    const recurringNote =
      showRecurring && item.recurring
        ? item.first_seen_days_ago && item.first_seen_days_ago > 1
          ? ` 🔴 *recurring ${item.first_seen_days_ago}d*`
          : ' 🔴 *recurring*'
        : showRecurring && !item.recurring
          ? ' 🆕'
          : '';
    return `• ${item.text}${authorsNote}${recurringNote}`;
  }

  const topicsText = pulse.topics.map(t => formatItem(t)).join('\n') || '_Nothing notable_';
  const painText   = pulse.pain_points.map(p => formatItem(p, true)).join('\n') || '_Nothing notable_';
  const posText    = pulse.positives.map(p => formatItem(p)).join('\n') || '_Nothing notable_';

  const moodScore  = Math.min(5, Math.max(1, Math.round(pulse.mood_score ?? 3)));
  const moodBar    = '█'.repeat(moodScore) + '░'.repeat(5 - moodScore);
  const moodColour = moodScore >= 4 ? 0x2ECC71 : moodScore <= 2 ? 0xE74C3C : 0x9B59B6;

  const embed = new EmbedBuilder()
    .setTitle(`💬 Community Pulse — ${today}`)
    .setColor(moodColour)
    .setDescription(`AI-generated summary of recent player discussion *(${messages.length} messages analysed)*`)
    .addFields(
      {
        name:   '📌 Top Topics',
        value:  topicsText,
        inline: false,
      },
      {
        name:   '😤 Pain Points',
        value:  painText,
        inline: true,
      },
      {
        name:   '😊 Positives',
        value:  posText,
        inline: true,
      },
      {
        name:   '🔥 Trending Today',
        value:  pulse.trending || '_Nothing unusually trending_',
        inline: false,
      },
    );

  embed
    .addFields({
      name:   `🌡️ Mood — ${moodScore}/5  ${moodBar}`,
      value:  pulse.mood,
      inline: false,
    })
    .setFooter({ text: 'WoWS Community Reports · AI-generated by OpenAI · 🔴 recurring  🆕 new today' })
    .setTimestamp();

  // ── Post ───────────────────────────────────────────────────────────────────
  await postDailyReport(embed);
  logger.info('[sentiment] Community Pulse report posted');
}
