/**
 * AI-powered Narrative Drift Tracker
 *
 * Uses gpt-4.1-mini to classify raw Discord messages into per-category
 * daily sentiment scores. Runs alongside the lexicon-based narrativeDb.ts
 * so both can be compared side-by-side in the dashboard.
 *
 * Results are stored in narrative_ai_daily / narrative_ai_keywords tables.
 *
 * Controlled by NARRATIVE_AI_ENABLED=true in .env.
 * Disable : set NARRATIVE_AI_ENABLED=false — tab disappears, cron skips.
 * Remove  : delete this file + drop the narrative_ai_* tables + remove the
 *           AI tab from NarrativeClient.tsx + remove from server.ts/scheduler.ts.
 */

import Database from 'better-sqlite3';
import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../logger';
import { getDb } from './db';
import { CATEGORIES } from './narrativeDb';

// ── OpenAI client ──────────────────────────────────────────────────────────────

function getClient(): OpenAI {
  return new OpenAI({ apiKey: config.openAiApiKey });
}

// ── Message DB ─────────────────────────────────────────────────────────────────

function openMsgDb(): Database.Database {
  return new Database(config.messageDbPath, { readonly: true, fileMustExist: true });
}

// ── GPT response schema ────────────────────────────────────────────────────────

interface AiCategoryResult {
  sentiment:      number;    // 1–5
  volume:         number;    // total relevant messages
  pain_count:     number;
  positive_count: number;
  keywords:       string[];  // up to 5 distinctive words/phrases
}

interface AiDayResult {
  categories:       Record<string, AiCategoryResult>;
  emerging_topics:  { keyword: string; count: number }[];
}

// ── System prompt ──────────────────────────────────────────────────────────────

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  economy:     'Economy & Grind — credits, doubloons, coal, steel, grind, pay to win, premium ships, containers, bundles, directives',
  balance:     'Balance — overpowered ships, nerf/buff, fire/flooding, secondaries, concealment, overmatch, cruisers, destroyers, battleships',
  matchmaking: 'Matchmaking — tier spread, uptiered, queue balance, one-sided teams, SBMM, seal clubbing, divisions',
  carriers:    'Carriers — CVs, aircraft, rocket planes, bombers, torpedo bombers, aviation spotting',
  submarines:  'Submarines — ASW, depth charges, pinging, sonar, homing torpedoes, hydrophone',
  new_content: 'New Ships & Content — tech tree, premium ships, early access, super ships, patches, reworks',
  performance: 'Client & Performance — FPS, lag, ping, crashes, bugs, disconnects, desync',
  trust:       'Trust & Communication — Wargaming comms, devs, roadmap, transparency, promises, dev blog',
  game_modes:  'Game Modes — ranked, clan battles, co-op, operations, brawl, random battles, convoy',
  moderation:  'Toxicity & Community — toxic behaviour, chat bans, report system, team killing, griefing',
};

const SYSTEM_PROMPT = `You are analysing raw Discord messages from a World of Warships community server.

Your task: for each of the 10 topic categories below, read the provided messages and produce:
- sentiment: 1 (very negative) to 5 (very positive), 3 = neutral. Reflect the actual tone — don't average towards 3 if messages are clearly negative or positive.
- volume: count of messages that meaningfully discuss this category (not just a passing mention)
- pain_count: messages expressing clear frustration, complaints, or criticism about this category
- positive_count: messages expressing satisfaction, praise, or excitement about this category
- keywords: up to 5 most distinctive words or short phrases mentioned in this category's context

Categories:
${Object.entries(CATEGORY_DESCRIPTIONS).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

Also identify up to 8 topics or words being discussed that don't fit any of the above categories (emerging_topics), with an estimated mention count.

Respond with valid JSON only — no commentary, no markdown:
{
  "categories": {
    "economy":     { "sentiment": 2.8, "volume": 34, "pain_count": 12, "positive_count": 3, "keywords": ["grind", "credits", "coal", "premium", "doubloon"] },
    "balance":     { "sentiment": 3.1, "volume": 58, "pain_count": 14, "positive_count": 10, "keywords": ["nerf", "overmatch", "HE spam", "fire", "concealment"] },
    "matchmaking": { ... },
    "carriers":    { ... },
    "submarines":  { ... },
    "new_content": { ... },
    "performance": { ... },
    "trust":       { ... },
    "game_modes":  { ... },
    "moderation":  { ... }
  },
  "emerging_topics": [
    { "keyword": "Yamato", "count": 23 },
    { "keyword": "clan season", "count": 18 }
  ]
}

If a category has no relevant messages, set sentiment to 3.0 and volume/pain_count/positive_count to 0.`;

// ── Limits ─────────────────────────────────────────────────────────────────────

const MAX_MESSAGES_PER_DAY = 5_000;
const MAX_MSG_CHARS        = 200;

// ── Core daily processing ──────────────────────────────────────────────────────

async function processDayAI(date: string, msgDb: Database.Database): Promise<void> {
  const db = getDb();

  const startMs = Date.parse(`${date}T00:00:00.000Z`);
  const endMs   = startMs + 86_400_000;

  const messages = msgDb.prepare(
    'SELECT content FROM discord_messages WHERE created_at >= ? AND created_at < ? LIMIT ?',
  ).all(startMs, endMs, MAX_MESSAGES_PER_DAY) as { content: string }[];

  if (messages.length === 0) {
    logger.debug(`[narrative-ai] No messages for ${date} — skipping`);
    return;
  }

  const msgBlock = messages
    .map((m, i) => `${i + 1}. ${m.content.slice(0, MAX_MSG_CHARS).replace(/\n+/g, ' ')}`)
    .join('\n');

  let result: AiDayResult;
  try {
    const response = await getClient().chat.completions.create({
      model:           'gpt-4.1-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: `Messages from ${date} (${messages.length} total):\n\n${msgBlock}` },
      ],
    });
    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error('Empty response from gpt-4.1-mini');
    result = JSON.parse(raw) as AiDayResult;
  } catch (err) {
    logger.error(`[narrative-ai] GPT call failed for ${date}:`, err);
    return;
  }

  // Upsert per-category rows
  const upsert = db.prepare(`
    INSERT INTO narrative_ai_daily
      (date, category, pain_count, positive_count, topic_count, sentiment, mood_ref, items_json)
    VALUES (?, ?, ?, ?, ?, ?, 3.0, NULL)
    ON CONFLICT(date, category) DO UPDATE SET
      pain_count     = excluded.pain_count,
      positive_count = excluded.positive_count,
      topic_count    = excluded.topic_count,
      sentiment      = excluded.sentiment
  `);

  for (const catId of Object.keys(CATEGORIES)) {
    const cat = result.categories?.[catId];
    if (!cat || cat.volume === 0) continue;
    const neutral   = Math.max(0, cat.volume - cat.pain_count - cat.positive_count);
    const sentiment = Math.min(5, Math.max(1, cat.sentiment));
    upsert.run(date, catId, cat.pain_count, cat.positive_count, neutral, sentiment);
  }

  // Upsert emerging keywords
  const kwUpsert = db.prepare(`
    INSERT INTO narrative_ai_keywords (date, keyword, count) VALUES (?, ?, ?)
    ON CONFLICT(date, keyword) DO UPDATE SET count = excluded.count
  `);
  for (const { keyword, count } of result.emerging_topics ?? []) {
    if (keyword && count > 0) kwUpsert.run(date, keyword.slice(0, 60), count);
  }

  logger.info(
    `[narrative-ai] Processed ${date}: ${messages.length} messages → ` +
    `${Object.values(result.categories ?? {}).filter(c => c.volume > 0).length} active categories`,
  );
}

// ── Public write functions ─────────────────────────────────────────────────────

export async function processYesterdayFromMessagesAI(): Promise<void> {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  try {
    const msgDb = openMsgDb();
    try {
      await processDayAI(yesterday, msgDb);
    } finally {
      msgDb.close();
    }
  } catch (err) {
    logger.warn('[narrative-ai] processYesterdayFromMessagesAI failed:', err);
  }
}

export async function reprocessNarrativeHistoryAI(): Promise<{ processed: number; errors: number }> {
  const db = getDb();
  db.prepare('DELETE FROM narrative_ai_daily').run();
  db.prepare('DELETE FROM narrative_ai_keywords').run();
  logger.info('[narrative-ai] Cleared AI narrative tables for full reprocess');

  let msgDb: Database.Database;
  try {
    msgDb = openMsgDb();
  } catch (err) {
    logger.error('[narrative-ai] Could not open message DB:', err);
    return { processed: 0, errors: 1 };
  }

  const dates = (msgDb.prepare(
    `SELECT DISTINCT date(created_at / 1000, 'unixepoch') AS d
     FROM discord_messages ORDER BY d ASC`,
  ).all() as { d: string }[]).map(r => r.d);

  let processed = 0;
  let errors    = 0;

  for (const date of dates) {
    try {
      await processDayAI(date, msgDb);
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[narrative-ai] Failed to process ${date}: ${msg}`);
      errors++;
    }
  }

  msgDb.close();
  logger.info(`[narrative-ai] Reprocess complete: ${processed} ok, ${errors} errors`);
  return { processed, errors };
}

// ── Read functions (same signatures as narrativeDb.ts) ────────────────────────

export interface HeatmapWeek {
  weekLabel:  string;
  weekStart:  string;
  categories: Record<string, { sentiment: number | null; itemCount: number }>;
}
export interface HeatmapResponse {
  weeks:        HeatmapWeek[];
  categoryMeta: Record<string, { label: string }>;
}

export function getNarrativeHeatmapAI(weeks = 12): HeatmapResponse {
  const db     = getDb();
  const result: HeatmapWeek[] = [];
  const now    = new Date();

  for (let i = weeks - 1; i >= 0; i--) {
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() - i * 7);
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekEnd.getDate() - 6);

    const startStr = weekStart.toISOString().slice(0, 10);
    const endStr   = weekEnd.toISOString().slice(0, 10);

    const rows = db.prepare(`
      SELECT category,
             AVG(sentiment)                                   AS avg_sentiment,
             SUM(pain_count + positive_count + topic_count)   AS total_items
      FROM narrative_ai_daily
      WHERE date >= ? AND date <= ?
      GROUP BY category
    `).all(startStr, endStr) as { category: string; avg_sentiment: number; total_items: number }[];

    const categories: Record<string, { sentiment: number | null; itemCount: number }> = {};
    for (const catId of Object.keys(CATEGORIES)) {
      categories[catId] = { sentiment: null, itemCount: 0 };
    }
    for (const row of rows) {
      if (categories[row.category] !== undefined) {
        categories[row.category] = {
          sentiment: Math.round(row.avg_sentiment * 100) / 100,
          itemCount: row.total_items,
        };
      }
    }

    const label = weekStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    result.push({ weekLabel: label, weekStart: startStr, categories });
  }

  const categoryMeta: Record<string, { label: string }> = {};
  for (const [id, { label }] of Object.entries(CATEGORIES)) {
    categoryMeta[id] = { label };
  }
  return { weeks: result, categoryMeta };
}

export interface DriftAlert {
  level:             'danger' | 'warning' | 'emerging';
  tier?:             1 | 2;  // 1 = immediate (24h vs 14d baseline), 2 = confirmed (3d vs 14d baseline)
  category:          string;
  label:             string;
  detail:            string;
  currentSentiment?: number;
  priorSentiment?:   number;
  volumeChange?:     number;
}
export interface DriftResponse {
  alerts:       DriftAlert[];
  generated_at: string;
  categoryMeta: Record<string, { label: string }>;
}

export function getNarrativeDriftAI(): DriftResponse {
  const db  = getDb();
  const now = new Date();
  const day0  = now.toISOString().slice(0, 10);
  const day1  = new Date(now.getTime() -  1 * 86_400_000).toISOString().slice(0, 10);
  const day3  = new Date(now.getTime() -  3 * 86_400_000).toISOString().slice(0, 10);
  const day7  = new Date(now.getTime() -  7 * 86_400_000).toISOString().slice(0, 10);
  const day14 = new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
  const day15 = new Date(now.getTime() - 15 * 86_400_000).toISOString().slice(0, 10);
  const day17 = new Date(now.getTime() - 17 * 86_400_000).toISOString().slice(0, 10);

  type AggRow = { category: string; avg_sentiment: number; total_items: number };

  const query = db.prepare(`
    SELECT category, AVG(sentiment) AS avg_sentiment,
           SUM(pain_count + positive_count + topic_count) AS total_items
    FROM narrative_ai_daily WHERE date > ? AND date <= ? GROUP BY category
  `);

  // Tier 1: yesterday vs 14-day baseline
  const t1Signal   = query.all(day1, day0) as AggRow[];
  const t1Baseline = query.all(day15, day1) as AggRow[];
  const t1BaseMap  = new Map(t1Baseline.map(r => [r.category, r]));

  // Tier 2: last 3 days vs 14-day baseline
  const t2Signal   = query.all(day3, day0) as AggRow[];
  const t2Baseline = query.all(day17, day3) as AggRow[];
  const t2BaseMap  = new Map(t2Baseline.map(r => [r.category, r]));

  const alerts: DriftAlert[] = [];

  // ── Tier 1: immediate signal (yesterday vs 14d baseline) ─────────────────
  for (const curr of t1Signal) {
    const base  = t1BaseMap.get(curr.category);
    const label = CATEGORIES[curr.category]?.label ?? curr.category;
    if (!base) continue;

    const sentDrop   = curr.avg_sentiment - base.avg_sentiment;
    const signalRate = curr.total_items;
    const baseRate   = base.total_items / 14;
    const volChange  = baseRate > 0 ? (signalRate - baseRate) / baseRate : 0;
    const hasData    = curr.total_items >= 1 && base.total_items >= 5;

    if (sentDrop <= -0.4 && hasData) {
      alerts.push({
        tier: 1, level: 'danger', category: curr.category, label,
        detail:           `Yesterday ${curr.avg_sentiment.toFixed(2)} vs 14d avg ${base.avg_sentiment.toFixed(2)}`,
        currentSentiment: Math.round(curr.avg_sentiment * 100) / 100,
        priorSentiment:   Math.round(base.avg_sentiment * 100) / 100,
        volumeChange:     Math.round(volChange * 100) / 100,
      });
    } else if (volChange >= 0.8 && hasData) {
      alerts.push({
        tier: 1, level: 'warning', category: curr.category, label,
        detail:           `Yesterday ${curr.total_items} items vs 14d daily avg ${baseRate.toFixed(1)} (+${(volChange * 100).toFixed(0)}%)`,
        currentSentiment: Math.round(curr.avg_sentiment * 100) / 100,
        priorSentiment:   Math.round(base.avg_sentiment * 100) / 100,
        volumeChange:     Math.round(volChange * 100) / 100,
      });
    }
  }

  // ── Tier 2: confirmed shift (3-day avg vs 14d baseline) ──────────────────
  for (const curr of t2Signal) {
    const base  = t2BaseMap.get(curr.category);
    const label = CATEGORIES[curr.category]?.label ?? curr.category;
    if (!base) continue;

    const sentDrop   = curr.avg_sentiment - base.avg_sentiment;
    const signalRate = curr.total_items / 3;
    const baseRate   = base.total_items / 14;
    const volChange  = baseRate > 0 ? (signalRate - baseRate) / baseRate : 0;
    const hasData    = curr.total_items >= 3 && base.total_items >= 10;

    if (sentDrop <= -0.3 && hasData) {
      alerts.push({
        tier: 2, level: 'danger', category: curr.category, label,
        detail:           `3d avg ${curr.avg_sentiment.toFixed(2)} vs 14d baseline ${base.avg_sentiment.toFixed(2)}`,
        currentSentiment: Math.round(curr.avg_sentiment * 100) / 100,
        priorSentiment:   Math.round(base.avg_sentiment * 100) / 100,
        volumeChange:     Math.round(volChange * 100) / 100,
      });
    } else if (volChange >= 0.5 && hasData) {
      alerts.push({
        tier: 2, level: 'warning', category: curr.category, label,
        detail:           `3d daily avg ${signalRate.toFixed(1)} items vs 14d baseline ${baseRate.toFixed(1)} (+${(volChange * 100).toFixed(0)}%)`,
        currentSentiment: Math.round(curr.avg_sentiment * 100) / 100,
        priorSentiment:   Math.round(base.avg_sentiment * 100) / 100,
        volumeChange:     Math.round(volChange * 100) / 100,
      });
    }
  }

  // ── Emerging keywords from AI output (last 7 days vs prior 7) ────────────
  type KwRow = { keyword: string; total: number };
  const emergingKw = db.prepare(`
    SELECT keyword, SUM(count) AS total FROM narrative_ai_keywords
    WHERE date > ? GROUP BY keyword HAVING total >= 3 ORDER BY total DESC LIMIT 10
  `).all(day7) as KwRow[];

  const priorKw = db.prepare(`
    SELECT keyword, SUM(count) AS total FROM narrative_ai_keywords
    WHERE date > ? AND date <= ? GROUP BY keyword
  `).all(day14, day7) as KwRow[];
  const priorKwMap = new Map(priorKw.map(k => [k.keyword, k.total]));

  for (const kw of emergingKw) {
    const priorCount = priorKwMap.get(kw.keyword) ?? 0;
    if (kw.total > priorCount * 2) {
      alerts.push({
        level: 'emerging', category: 'emerging',
        label:  `"${kw.keyword}"`,
        detail: `${kw.total} mentions this week (${priorCount} last week) — AI-identified topic`,
      });
    }
  }

  // Sort: tier 1 → tier 2 → no tier; within tier: danger → warning → emerging
  const levelP = { danger: 0, warning: 1, emerging: 2 } as const;
  alerts.sort((a, b) => {
    const ta = a.tier ?? 3;
    const tb = b.tier ?? 3;
    if (ta !== tb) return ta - tb;
    return levelP[a.level] - levelP[b.level];
  });

  const categoryMeta: Record<string, { label: string }> = {};
  for (const [id, { label }] of Object.entries(CATEGORIES)) {
    categoryMeta[id] = { label };
  }
  return { alerts, generated_at: new Date().toISOString(), categoryMeta };
}

export interface DailyPoint {
  date:           string;
  sentiment:      number;
  item_count:     number;
  pain_count:     number;
  positive_count: number;
}

export function getCategoryTrendAI(category: string, days = 90): DailyPoint[] {
  const db    = getDb();
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db.prepare(`
    SELECT date, sentiment,
           pain_count + positive_count + topic_count AS item_count,
           pain_count, positive_count
    FROM narrative_ai_daily
    WHERE category = ? AND date >= ?
    ORDER BY date ASC
  `).all(category, since) as DailyPoint[];
}

export interface EmergingKeyword {
  keyword:     string;
  recentCount: number;
  priorCount:  number;
  heat:        'hot' | 'warm' | 'cool';
}

export function getEmergingKeywordsAI(days = 14): EmergingKeyword[] {
  const db       = getDb();
  const now      = Date.now();
  const halfDays = Math.ceil(days / 2);
  const recentSince = new Date(now - halfDays * 86_400_000).toISOString().slice(0, 10);
  const allSince    = new Date(now - days   * 86_400_000).toISOString().slice(0, 10);

  type KwRow = { keyword: string; total: number };

  const recent = db.prepare(`
    SELECT keyword, SUM(count) AS total FROM narrative_ai_keywords
    WHERE date >= ? GROUP BY keyword ORDER BY total DESC LIMIT 50
  `).all(recentSince) as KwRow[];

  const prior = db.prepare(`
    SELECT keyword, SUM(count) AS total FROM narrative_ai_keywords
    WHERE date >= ? AND date < ? GROUP BY keyword
  `).all(allSince, recentSince) as KwRow[];
  const priorMap = new Map(prior.map(k => [k.keyword, k.total]));

  return recent
    .filter(r => r.total >= 2)
    .map(r => ({
      keyword:     r.keyword,
      recentCount: r.total,
      priorCount:  priorMap.get(r.keyword) ?? 0,
      heat: (r.total >= 20 ? 'hot' : r.total >= 10 ? 'warm' : 'cool') as 'hot' | 'warm' | 'cool',
    }));
}
