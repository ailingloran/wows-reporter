/**
 * Narrative Drift Tracker
 *
 * After each Community Pulse report, classify each topic/pain_point/positive item
 * into WoWs topic categories using keyword matching. Aggregate daily per-category
 * sentiment scores and detect week-over-week drift.
 */

import { getDb } from './db';
import { PulseResult, PulseItem } from '../api/openai';
import { logger } from '../logger';

// ── WoWs topic taxonomy ────────────────────────────────────────────────────────

export const CATEGORIES: Record<string, { label: string; keywords: string[] }> = {
  economy: {
    label: 'Economy & Grind',
    keywords: [
      'credit', 'doubloon', 'free xp', 'coal', 'steel', 'grind', 'pay to win', 'p2w',
      'premium', 'expensiv', 'crate', 'container', 'research bureau', 'dockyard',
      'cost', 'price', 'loot box', 'earnable', 'resource', 'earn', 'reward',
    ],
  },
  balance: {
    label: 'Balance & Meta',
    keywords: [
      'overpowered', ' op ', 'broken', 'nerf', 'buff', 'meta', 'he spam', 'fire chance',
      'flooding', 'matchmaking', 'uptiered', 'tier spread', 'unbalanced', 'overtuned',
      'balance', 'powercreep', 'power creep',
    ],
  },
  carriers_subs: {
    label: 'Carriers & Subs',
    keywords: [
      'carrier', 'submarine', ' sub ', 'depth charge', 'torpedo soup', 'aerial',
      'airstrike', 'rocket plane', 'attack aircraft', 'spotting plane',
      ' cv ', ' cvs ', ' subs ',
    ],
  },
  new_content: {
    label: 'New Ships & Content',
    keywords: [
      'tech tree', 'premium ship', 'early access', 'paper ship', 'coal ship',
      'steel ship', 'super ship', 'new ship', 'dockyard', 'announced', 'coming soon',
      'update ', 'patch ', 'new release', 'test ship',
    ],
  },
  performance: {
    label: 'Client & Performance',
    keywords: [
      'fps', 'lag', ' ping', 'crash', ' bug ', 'bugged', 'patch broke',
      'launcher', 'performance', 'stutter', 'disconnect', 'freeze', 'broken client',
      'server issue', 'desync',
    ],
  },
  trust: {
    label: 'Trust & Communication',
    keywords: [
      'no communication', 'wargaming', ' wg ', 'ignor', 'tone deaf', 'transparency',
      'roadmap', 'abandon', 'lied', 'promis', 'listen to player', 'player feedback',
      'community feedback', 'no response', 'silence', 'mislead',
    ],
  },
  game_modes: {
    label: 'Game Modes',
    keywords: [
      'ranked', 'clan battles', 'co-op', 'operations', 'scenario', 'brawl',
      'arms race', 'asymmetric', 'removed mode', 'bring back', 'missing mode',
      'game mode', 'sprint',
    ],
  },
  moderation: {
    label: 'Toxicity & Community',
    keywords: [
      'toxic', 'chat ban', 'report system', 'teamkill', ' afk ', 'seal clubbing',
      'harassment', 'cheating', 'bot player', 'griefing', 'unsportsmanlike',
    ],
  },
};

// Flat set of all category keywords for emerging keyword detection
const ALL_CATEGORY_KEYWORDS = new Set<string>(
  Object.values(CATEGORIES).flatMap(c => c.keywords.map(k => k.trim())),
);

// ── Text helpers ───────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'have', 'from', 'they',
  'their', 'about', 'more', 'some', 'most', 'many', 'very', 'when',
  'which', 'were', 'been', 'are', 'was', 'not', 'but', 'its', 'our',
  'all', 'can', 'will', 'just', 'also', 'even', 'still', 'than', 'then',
  'into', 'over', 'each', 'only', 'like', 'game', 'player', 'players',
  'ship', 'ships', 'discussing', 'discussion', 'community', 'server', 'user',
]);

function extractWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOPWORDS.has(w));
}

function matchCategories(text: string): string[] {
  const padded = ` ${text.toLowerCase()} `;
  return Object.entries(CATEGORIES)
    .filter(([, { keywords }]) => keywords.some(kw => padded.includes(kw)))
    .map(([id]) => id);
}

// ── Main categorization ────────────────────────────────────────────────────────

type ItemKind = 'pain_point' | 'positive' | 'topic';

export function categorizeAndStorePulseReport(pulse: PulseResult, date: string): void {
  const db = getDb();
  const moodScore = Math.min(5, Math.max(1, pulse.mood_score ?? 3));

  // Normalise citations to string keys (JSON.parse converts numeric keys → strings)
  const citationMap: Record<string, string> = {};
  if (pulse.citations) {
    for (const [k, v] of Object.entries(pulse.citations)) {
      citationMap[String(k)] = v as string;
    }
  }

  // Collect all items
  const tagged: { kind: ItemKind; item: PulseItem; citedText: string }[] = [];
  const processItems = (items: PulseItem[], kind: ItemKind) => {
    for (const item of items) {
      const citedText = item.msgs
        .map(idx => citationMap[String(idx)] ?? '')
        .filter(Boolean)
        .join(' ');
      tagged.push({ kind, item, citedText });
    }
  };
  processItems(pulse.topics, 'topic');
  processItems(pulse.pain_points, 'pain_point');
  processItems(pulse.positives, 'positive');

  // Per-category aggregation
  const catData = new Map<string, { pain: number; pos: number; topic: number; items: string[] }>();

  for (const { kind, item, citedText } of tagged) {
    const fullText = `${item.text} ${citedText}`;
    const cats = matchCategories(fullText);
    for (const cat of cats) {
      if (!catData.has(cat)) catData.set(cat, { pain: 0, pos: 0, topic: 0, items: [] });
      const d = catData.get(cat)!;
      if (kind === 'pain_point') d.pain++;
      else if (kind === 'positive') d.pos++;
      else d.topic++;
      d.items.push(item.text);
    }
  }

  const upsert = db.prepare(`
    INSERT INTO narrative_daily (date, category, pain_count, positive_count, topic_count, sentiment, mood_ref, items_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, category) DO UPDATE SET
      pain_count     = excluded.pain_count,
      positive_count = excluded.positive_count,
      topic_count    = excluded.topic_count,
      sentiment      = excluded.sentiment,
      mood_ref       = excluded.mood_ref,
      items_json     = excluded.items_json
  `);

  for (const [cat, d] of catData.entries()) {
    const total = d.pain + d.pos + d.topic;
    // pain items → 1.5, topic items → mood_score, positive items → 4.5
    const sentiment = (d.pain * 1.5 + d.topic * moodScore + d.pos * 4.5) / total;
    upsert.run(date, cat, d.pain, d.pos, d.topic, sentiment, moodScore, JSON.stringify(d.items));
  }

  // Emerging keywords: words in items not covered by any category keyword
  const wordCounts = new Map<string, number>();
  for (const { item, citedText } of tagged) {
    const words = new Set(extractWords(`${item.text} ${citedText}`));
    for (const word of words) {
      if (!ALL_CATEGORY_KEYWORDS.has(word)) {
        wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
      }
    }
  }

  const kwUpsert = db.prepare(`
    INSERT INTO narrative_keywords (date, keyword, count) VALUES (?, ?, ?)
    ON CONFLICT(date, keyword) DO UPDATE SET count = excluded.count
  `);
  for (const [word, count] of wordCounts.entries()) {
    if (count >= 2) kwUpsert.run(date, word, count);
  }

  logger.info(`[narrative] Categorized ${date}: ${catData.size} categories, ${wordCounts.size} keywords`);
}

// ── Heatmap ────────────────────────────────────────────────────────────────────

export interface HeatmapWeek {
  weekLabel: string;
  weekStart: string;
  categories: Record<string, { sentiment: number | null; itemCount: number }>;
}

export interface HeatmapResponse {
  weeks: HeatmapWeek[];
  categoryMeta: Record<string, { label: string }>;
}

export function getNarrativeHeatmap(weeks = 12): HeatmapResponse {
  const db = getDb();
  const result: HeatmapWeek[] = [];
  const now = new Date();

  for (let i = weeks - 1; i >= 0; i--) {
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() - i * 7);
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekEnd.getDate() - 6);

    const startStr = weekStart.toISOString().slice(0, 10);
    const endStr   = weekEnd.toISOString().slice(0, 10);

    const rows = db.prepare(`
      SELECT category,
             AVG(sentiment) as avg_sentiment,
             SUM(pain_count + positive_count + topic_count) as total_items
      FROM narrative_daily
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

    // Label: "Mar 10" style
    const label = weekStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    result.push({ weekLabel: label, weekStart: startStr, categories });
  }

  const categoryMeta: Record<string, { label: string }> = {};
  for (const [id, { label }] of Object.entries(CATEGORIES)) {
    categoryMeta[id] = { label };
  }

  return { weeks: result, categoryMeta };
}

// ── Drift alerts ───────────────────────────────────────────────────────────────

export interface DriftAlert {
  level: 'danger' | 'warning' | 'emerging';
  category: string;
  label: string;
  detail: string;
  currentSentiment?: number;
  priorSentiment?: number;
  volumeChange?: number;
}

export interface DriftResponse {
  alerts: DriftAlert[];
  generated_at: string;
  categoryMeta: Record<string, { label: string }>;
}

export function getNarrativeDrift(): DriftResponse {
  const db = getDb();
  const now = new Date();
  const day0  = now.toISOString().slice(0, 10);
  const day7  = new Date(now.getTime() - 7  * 86400000).toISOString().slice(0, 10);
  const day14 = new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10);

  type AggRow = { category: string; avg_sentiment: number; total_items: number };

  const currentWeek = db.prepare(`
    SELECT category, AVG(sentiment) as avg_sentiment,
           SUM(pain_count + positive_count + topic_count) as total_items
    FROM narrative_daily WHERE date > ? AND date <= ? GROUP BY category
  `).all(day7, day0) as AggRow[];

  const priorWeek = db.prepare(`
    SELECT category, AVG(sentiment) as avg_sentiment,
           SUM(pain_count + positive_count + topic_count) as total_items
    FROM narrative_daily WHERE date > ? AND date <= ? GROUP BY category
  `).all(day14, day7) as AggRow[];

  const priorMap = new Map(priorWeek.map(r => [r.category, r]));
  const alerts: DriftAlert[] = [];

  for (const curr of currentWeek) {
    const prior = priorMap.get(curr.category);
    const label = CATEGORIES[curr.category]?.label ?? curr.category;

    if (prior) {
      const sentDrop  = curr.avg_sentiment - prior.avg_sentiment;
      const volChange = prior.total_items > 0
        ? (curr.total_items - prior.total_items) / prior.total_items
        : 0;

      if (sentDrop <= -0.2) {
        alerts.push({
          level: 'danger',
          category: curr.category,
          label,
          detail: `Sentiment ${prior.avg_sentiment.toFixed(2)} → ${curr.avg_sentiment.toFixed(2)} · vol ${volChange >= 0 ? '+' : ''}${(volChange * 100).toFixed(0)}%`,
          currentSentiment: Math.round(curr.avg_sentiment * 100) / 100,
          priorSentiment:   Math.round(prior.avg_sentiment * 100) / 100,
          volumeChange: Math.round(volChange * 100) / 100,
        });
      } else if (volChange >= 0.3 && curr.total_items >= 3) {
        alerts.push({
          level: 'warning',
          category: curr.category,
          label,
          detail: `Volume up ${(volChange * 100).toFixed(0)}% WoW (${curr.total_items} vs ${prior.total_items} items)`,
          currentSentiment: Math.round(curr.avg_sentiment * 100) / 100,
          priorSentiment:   Math.round(prior.avg_sentiment * 100) / 100,
          volumeChange: Math.round(volChange * 100) / 100,
        });
      }
    }
  }

  // Emerging keywords: appeared more this week vs last
  type KwRow = { keyword: string; total: number };
  const emergingKw = db.prepare(`
    SELECT keyword, SUM(count) as total FROM narrative_keywords
    WHERE date > ? GROUP BY keyword HAVING total >= 5 ORDER BY total DESC LIMIT 15
  `).all(day7) as KwRow[];

  const priorKw = db.prepare(`
    SELECT keyword, SUM(count) as total FROM narrative_keywords
    WHERE date > ? AND date <= ? GROUP BY keyword
  `).all(day14, day7) as KwRow[];
  const priorKwMap = new Map(priorKw.map(k => [k.keyword, k.total]));

  for (const kw of emergingKw) {
    const priorCount = priorKwMap.get(kw.keyword) ?? 0;
    if (kw.total > priorCount * 2) {
      alerts.push({
        level: 'emerging',
        category: 'emerging',
        label: `"${kw.keyword}"`,
        detail: `${kw.total} mentions this week (${priorCount} last week) — not in any tracked category`,
      });
    }
  }

  alerts.sort((a, b) => {
    const p = { danger: 0, warning: 1, emerging: 2 } as const;
    return p[a.level] - p[b.level];
  });

  const categoryMeta: Record<string, { label: string }> = {};
  for (const [id, { label }] of Object.entries(CATEGORIES)) {
    categoryMeta[id] = { label };
  }

  return { alerts, generated_at: new Date().toISOString(), categoryMeta };
}

// ── Category trend ─────────────────────────────────────────────────────────────

export interface DailyPoint {
  date: string;
  sentiment: number;
  itemCount: number;
  painCount: number;
  positiveCount: number;
}

export function getCategoryTrend(category: string, days = 90): DailyPoint[] {
  const db = getDb();
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return db.prepare(`
    SELECT date, sentiment,
           pain_count + positive_count + topic_count AS item_count,
           pain_count, positive_count
    FROM narrative_daily
    WHERE category = ? AND date >= ?
    ORDER BY date ASC
  `).all(category, since) as DailyPoint[];
}

// ── Emerging keywords ──────────────────────────────────────────────────────────

export interface EmergingKeyword {
  keyword: string;
  recentCount: number;
  priorCount: number;
  heat: 'hot' | 'warm' | 'cool';
}

export function getEmergingKeywords(days = 14): EmergingKeyword[] {
  const db = getDb();
  const now = Date.now();
  const halfDays = Math.ceil(days / 2);
  const recentSince = new Date(now - halfDays * 86400000).toISOString().slice(0, 10);
  const allSince    = new Date(now - days  * 86400000).toISOString().slice(0, 10);

  type KwRow = { keyword: string; total: number };
  const recent = db.prepare(`
    SELECT keyword, SUM(count) as total FROM narrative_keywords
    WHERE date >= ? GROUP BY keyword ORDER BY total DESC LIMIT 40
  `).all(recentSince) as KwRow[];

  const prior = db.prepare(`
    SELECT keyword, SUM(count) as total FROM narrative_keywords
    WHERE date >= ? AND date < ? GROUP BY keyword
  `).all(allSince, recentSince) as KwRow[];
  const priorMap = new Map(prior.map(k => [k.keyword, k.total]));

  return recent
    .filter(r => r.total >= 2)
    .map(r => ({
      keyword:     r.keyword,
      recentCount: r.total,
      priorCount:  priorMap.get(r.keyword) ?? 0,
      heat: r.total >= 8 ? 'hot' : r.total >= 4 ? 'warm' : 'cool' as 'hot' | 'warm' | 'cool',
    }));
}

// ── Backfill historical reports ────────────────────────────────────────────────

export function reprocessNarrativeHistory(): { processed: number; errors: number } {
  const db = getDb();
  const reports = db.prepare(
    `SELECT taken_at, raw_json FROM sentiment_reports ORDER BY taken_at ASC`,
  ).all() as { taken_at: string; raw_json: string }[];

  let processed = 0;
  let errors = 0;

  for (const report of reports) {
    try {
      const pulse = JSON.parse(report.raw_json) as PulseResult;
      categorizeAndStorePulseReport(pulse, report.taken_at.slice(0, 10));
      processed++;
    } catch {
      logger.warn(`[narrative] Failed to reprocess ${report.taken_at}`);
      errors++;
    }
  }

  logger.info(`[narrative] Reprocess complete: ${processed} ok, ${errors} errors`);
  return { processed, errors };
}
