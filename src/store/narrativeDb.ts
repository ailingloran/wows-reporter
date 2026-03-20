/**
 * Narrative Drift Tracker
 *
 * Processes raw Discord messages (from the message index DB) into per-category
 * daily sentiment scores using keyword matching and a simple positive/negative
 * word lexicon. Runs independently of the Community Pulse — no GPT cost.
 *
 * Sentiment formula per category per day:
 *   3.0 + (positive_frac - pain_frac × 1.5) × 8  →  clamped to 1–5
 * This fraction-based formula amplifies the detected signal so that ~10% pain
 * messages push the score to ~1.8, instead of being diluted by neutral messages.
 */

import Database from 'better-sqlite3';
import { getDb } from './db';
import { config } from '../config';
import { logger } from '../logger';

// ── WoWs topic taxonomy ────────────────────────────────────────────────────────

export const CATEGORIES: Record<string, { label: string; keywords: string[] }> = {
  economy: {
    label: 'Economy & Grind',
    keywords: [
      'credit', 'doubloon', 'free xp', 'coal', 'steel', 'grind', 'pay to win', 'p2w',
      'premium', 'crate', 'container', 'research bureau', 'dockyard',
      'cost', 'price', 'loot box', 'resource', 'earn', 'reward',
      'silver', 'snowflake', 'directive', 'campaign', 'combat mission',
      'bundle', 'token', 'trade-in', 'admiral bundle', 'supercontainer',
    ],
  },
  balance: {
    label: 'Balance',
    keywords: [
      'overpowered', ' op ', 'broken', 'nerf', 'buff', 'meta', 'he spam', 'fire chance',
      'flooding', 'unbalanced', 'overtuned', 'balance', 'powercreep', 'power creep',
      'cruiser', 'cruisers', 'destroyer', 'destroyers', 'battleship', 'battleships',
      'armor', 'armour', 'concealment', 'dispersion', 'accuracy', 'sigma',
      'overmatch', 'ricochet', 'smoke', 'secondaries', 'secondary',
    ],
  },
  matchmaking: {
    label: 'Matchmaking',
    keywords: [
      'matchmaking', 'matchmaker', 'uptiered', 'tier spread', ' mm ', 'sbmm',
      'queue time', 'team balance', 'divisions', 'one-sided', 'uneven teams',
      'seal clubbing', 'bottom tier', 'top tier', 'decompression', 'uptier',
    ],
  },
  carriers: {
    label: 'Carriers',
    keywords: [
      'carrier', 'aerial', 'airstrike', 'rocket plane', 'attack aircraft',
      'spotting plane', ' cv ', ' cvs ', 'aviation',
      'aircraft', 'bomber', 'torpedo bomber', 'fighter plane',
      ' plane ', 'planes', 'radar', 'hydro',
    ],
  },
  submarines: {
    label: 'Submarines',
    keywords: [
      'submarine', ' sub ', ' subs ', 'depth charge', 'torpedo soup',
      'ping', 'pinging', 'homing torpedo', 'acoustic', 'submerged',
      'asw', 'anti-submarine', 'hydrophone', 'sonar', 'patrolling',
      'torps', 'torpedo', 'torpedoes',
    ],
  },
  new_content: {
    label: 'New Ships & Content',
    keywords: [
      'tech tree', 'premium ship', 'early access', 'paper ship', 'coal ship',
      'steel ship', 'super ship', 'new ship', 'announced', 'coming soon',
      'update ', 'patch ', 'new release', 'test ship', 'new line', 'rework',
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
      'community feedback', 'no response', 'silence', 'mislead', 'dev blog', 'devs',
    ],
  },
  game_modes: {
    label: 'Game Modes',
    keywords: [
      'ranked', 'clan battles', 'co-op', 'operations', 'operation',
      'scenario', 'brawl', 'arms race', 'asymmetric', 'removed mode',
      'bring back', 'missing mode', 'game mode', 'sprint', 'randoms',
      'random battles', 'convoy', 'training room', 'public test',
    ],
  },
  moderation: {
    label: 'Toxicity & Community',
    keywords: [
      'toxic', 'chat ban', 'report system', 'teamkill', ' afk ', 'seal clubbing',
      'harassment', 'cheating', 'bot player', 'griefing', 'unsportsmanlike', 'flame',
    ],
  },
};

// ── Sentiment lexicon ──────────────────────────────────────────────────────────
// Simple word lists to classify each message as positive / neutral / pain.
// These are WoWs-context aware — generic "good" is intentionally omitted
// since it is overloaded ("good torpedoes hit", "good game") and adds noise.

const POSITIVE_WORDS = [
  // Strong positive
  'love', 'amazing', 'awesome', 'fantastic', 'wonderful', 'perfect',
  'brilliant', 'epic', 'impressive', 'exciting', 'nailed it',
  // Common gaming positives
  'fun', 'enjoy', 'great', 'nice', 'cool', 'good game', 'well played',
  'well done', 'good job', 'nice job', 'great addition', 'love this',
  'keep it up', 'really good', 'really nice', 'really fun',
  // Appreciation
  'appreciate', 'thank', 'happy', 'satisf', 'helpful', 'recommend',
  'favourite', 'favorite', 'love it', 'best ship', 'best update',
  'finally fixed', 'great job', 'nice work', 'good work',
];

const NEGATIVE_WORDS = [
  // Strong negative
  'frustrat', 'annoy', 'terrible', 'awful', 'hate', 'disappoint',
  'useless', 'garbage', 'trash', 'disgusting', 'outrageous', 'horrible',
  'pathetic', 'disgust', 'angry', 'outrag', 'shameful', 'embarrassing',
  // Common gaming complaints
  'broken', 'nerf ', 'needs to be nerfed', 'suck', 'sucks', 'sucked',
  'dumb', 'lame', 'stupid', 'ridiculous', 'absurd', 'insane mechanic',
  'unfair', 'unbalanced', 'boring', 'unplayable', 'unacceptable',
  // Monetisation
  'p2w', 'pay2win', 'pay to win', 'cashgrab', 'cash grab', 'money grab',
  'greed', 'greedy', 'predatory', 'scam', 'rigged',
  // Community
  'cancer', 'bullshit', 'toxic', 'cheat', 'exploit', 'ruin',
  'incompetent', 'neglect', 'waste of', 'disaster', 'failure',
];

// ── Text helpers ───────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  // Articles / conjunctions / prepositions
  'the', 'and', 'for', 'that', 'this', 'with', 'have', 'from', 'they',
  'their', 'about', 'more', 'some', 'most', 'many', 'very', 'when',
  'which', 'were', 'been', 'are', 'was', 'not', 'but', 'its', 'our',
  'all', 'can', 'will', 'just', 'also', 'even', 'still', 'than', 'then',
  'into', 'over', 'each', 'only', 'like', 'while', 'since', 'until',
  'after', 'before', 'above', 'below', 'between', 'through', 'during',
  'because', 'though', 'although', 'unless', 'whether', 'either',
  'those', 'these', 'their', 'there', 'where', 'which', 'whose',
  // Common verbs
  'play', 'plays', 'played', 'playing',
  'think', 'thinks', 'thought', 'thinking',
  'know', 'knows', 'known', 'knowing',
  'make', 'makes', 'made', 'making',
  'take', 'takes', 'taken', 'taking',
  'come', 'comes', 'came', 'coming',
  'seem', 'seems', 'seemed', 'feeling',
  'look', 'looks', 'looked', 'looking',
  'want', 'wants', 'wanted', 'wanting',
  'need', 'needs', 'needed', 'needing',
  'give', 'gives', 'given', 'giving',
  'find', 'finds', 'found', 'finding',
  'keep', 'keeps', 'kept', 'keeping',
  'show', 'shows', 'shown', 'showing',
  'mean', 'means', 'meant', 'meaning',
  'work', 'works', 'worked', 'working',
  'miss', 'using', 'doing', 'going', 'being', 'having', 'getting',
  'saying', 'seeing', 'trying', 'putting', 'turning', 'asking',
  // Common adjectives / adverbs
  'good', 'great', 'best', 'better', 'worse', 'worst', 'right', 'wrong',
  'real', 'really', 'quite', 'pretty', 'fairly', 'truly', 'simply',
  'often', 'never', 'always', 'again', 'maybe', 'might', 'could',
  'would', 'should', 'shall', 'other', 'every', 'first', 'second',
  'third', 'today', 'times', 'later', 'early', 'small', 'large',
  'much', 'less', 'least', 'well', 'back', 'away', 'down', 'long',
  'high', 'left', 'last', 'next', 'same', 'else', 'such',
  // Common nouns (too generic)
  'game', 'games', 'player', 'players', 'ship', 'ships', 'team', 'teams',
  'time', 'times', 'line', 'lines', 'mode', 'modes', 'thing', 'things',
  'issue', 'issues', 'change', 'changes', 'point', 'points', 'level',
  'type', 'types', 'part', 'parts', 'place', 'case', 'fact', 'kind',
  'main', 'range', 'event', 'people', 'person', 'someone', 'everyone',
  'anyone', 'nothing', 'something', 'anything', 'where', 'there', 'here',
  // WoWs generic (too broad to be meaningful as emerging signals)
  'discussing', 'discussion', 'community', 'server', 'user', 'users',
  'battle', 'battles', 'match', 'matches', 'round', 'rounds', 'average',
  // More adverbs / adjectives
  'without', 'especially', 'higher', 'lower', 'actual', 'actually',
  'already', 'please', 'number', 'learn', 'however', 'mostly', 'another',
  'random', 'strong', 'heavy', 'world', 'system', 'health', 'damage',
  'thats', 'talking', 'mostly', 'pretty', 'seriously', 'basically',
  'literally', 'honestly', 'totally', 'completely', 'absolutely',
  'important', 'different', 'possible', 'certain', 'specific', 'current',
  'problem', 'problems', 'reason', 'result', 'answer', 'example',
  'instead', 'against', 'around', 'really', 'though', 'almost', 'entire',
  'number', 'amount', 'enough', 'little', 'several', 'various',
  'within', 'beyond', 'toward', 'across', 'behind', 'beside',
  // More generics that keep sneaking through
  'speed', 'build', 'close', 'party', 'weeks', 'limit', 'single',
  'rather', 'purely', 'probably', 'outside', 'choice', 'minimum',
  'general', 'improved', 'surface', 'seconds', 'teammates', 'random',
  // Fragments & filler
  'dont', 'doesnt', 'didnt', 'cant', 'wont', 'isnt', 'wasnt', 'arent',
  'havent', 'hadnt', 'hasnt', 'also', 'yeah', 'yep', 'nope', 'okay',
  'think', 'maybe', 'whatever', 'whenever', 'however',
  // Generic adverbs / sentiment words that add no signal
  'currently', 'usually', 'mainly', 'following', 'changing', 'older',
  'awful', 'chance', 'hours', 'impact', 'express',
  // Slang / Discord filler
  'dunno', 'shrugeg', 'shrug', 'dashaha',
  'gonna', 'kinda', 'gotta', 'wanna', 'lemme', 'gimme',
  'guess', 'cause', 'couse', 'tho', 'tbh', 'imo', 'imho', 'ngl',
  'anyway', 'anyways', 'regardless',
  // Generic verbs/states
  'sometimes', 'remember', 'imagine', 'started', 'years', 'money',
  'shoot', 'worth', 'whole', 'funny', 'weird', 'crazy', 'insane',
  'enemy', 'allied', 'allies', 'human', 'world', 'super',
  'happen', 'happened', 'happens', 'called', 'tried', 'forgot',
  'sounds', 'wonder', 'check', 'understand', 'understood',
  'except', 'anymore', 'longer', 'faster', 'slower', 'bigger',
  'normal', 'start', 'reset', 'fight', 'whats', 'question',
  'stuff', 'version', 'thanks', 'thank',
  // Contraction fragments (apostrophe stripped)
  'wouldn', 'couldn', 'shouldn', 'weren', 'didn', 'haven',
  // URL fragments
  'https', 'http', 'discord', 'reddit', 'imgur',
  // Contraction fragments (apostrophe stripped)
  'doesn', 'haven', 'wasn', 'aren', 'hadn', 'hasn',
  // Other generics caught in review
  'everything', 'nothing', 'something', 'anything',
  'shoots', 'builds', 'stats', 'chance', 'reload',
  // Caught from AI comparison — generic words leaking through as emerging keywords
  'skill', 'skills', 'class', 'shells', 'shell', 'stupid', 'sleep',
  'sense', 'potential', 'decent', 'target', 'watch', 'light',
  'island', 'account', 'captain', 'experience', 'minutes',
  'shooting', 'spotting', 'gameplay', 'missions', 'mission',
  'british', 'american', 'fucking', 'myself', 'under',
  'broadside', 'turret', 'angle', 'italian', 'german', 'french',
  'russian', 'japanese', 'dutch', 'spanish', 'polish', 'swedish',
]);

// Flat set of all category keywords for emerging keyword detection
const ALL_CATEGORY_KEYWORDS = new Set<string>(
  Object.values(CATEGORIES).flatMap(c => c.keywords.map(k => k.trim())),
);

// Pre-computed list of single-word category keywords for fast substring matching
const SINGLE_WORD_CATEGORY_KEYWORDS = Array.from(ALL_CATEGORY_KEYWORDS)
  .filter(kw => !kw.trim().includes(' '))
  .map(kw => kw.trim());

function scoreMessage(content: string): 'pain' | 'positive' | 'neutral' {
  const lower = content.toLowerCase();
  const negHits = NEGATIVE_WORDS.filter(w => lower.includes(w)).length;
  const posHits = POSITIVE_WORDS.filter(w => lower.includes(w)).length;
  const net = posHits - negHits * 1.5;
  if (net > 0) return 'positive';
  if (net < 0) return 'pain';
  return 'neutral';
}

function matchCategories(text: string): string[] {
  const padded = ` ${text.toLowerCase()} `;
  return Object.entries(CATEGORIES)
    .filter(([, { keywords }]) => keywords.some(kw => padded.includes(kw)))
    .map(([id]) => id);
}

function extractWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => {
      if (w.length < 5) return false;
      if (STOPWORDS.has(w)) return false;
      if (/^user\d+$/.test(w)) return false;   // UserN labels
      if (/^\d+$/.test(w)) return false;        // pure numbers
      // Filter words whose stem is already covered by a category keyword
      for (const kw of SINGLE_WORD_CATEGORY_KEYWORDS) {
        if (w.includes(kw)) return false;
      }
      return true;
    });
}

// ── Message DB helpers ─────────────────────────────────────────────────────────

function openMsgDb(): Database.Database {
  return new Database(config.messageDbPath, { readonly: true, fileMustExist: true });
}

// ── Core daily processing ──────────────────────────────────────────────────────

function processDay(date: string, msgDb: Database.Database): void {
  const db = getDb();

  // UTC midnight boundaries for the date
  const startMs = Date.parse(`${date}T00:00:00.000Z`);
  const endMs   = startMs + 86_400_000;

  const messages = msgDb.prepare(
    'SELECT content FROM discord_messages WHERE created_at >= ? AND created_at < ?',
  ).all(startMs, endMs) as { content: string }[];

  if (messages.length === 0) {
    logger.debug(`[narrative] No messages for ${date} — skipping`);
    return;
  }

  // Per-category aggregation
  const catData = new Map<string, { pain: number; pos: number; neutral: number }>();

  // Emerging keywords: count distinct messages containing each word
  const wordCounts = new Map<string, number>();

  for (const { content } of messages) {
    const cats = matchCategories(content);
    if (cats.length > 0) {
      const score = scoreMessage(content);
      for (const cat of cats) {
        if (!catData.has(cat)) catData.set(cat, { pain: 0, pos: 0, neutral: 0 });
        const d = catData.get(cat)!;
        if (score === 'pain') d.pain++;
        else if (score === 'positive') d.pos++;
        else d.neutral++;
      }
    }

    // Extract emerging keywords from every message (including uncategorised ones)
    const words = new Set(extractWords(content));
    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }

  const upsert = db.prepare(`
    INSERT INTO narrative_daily
      (date, category, pain_count, positive_count, topic_count, sentiment, mood_ref, items_json)
    VALUES (?, ?, ?, ?, ?, ?, 3.0, NULL)
    ON CONFLICT(date, category) DO UPDATE SET
      pain_count     = excluded.pain_count,
      positive_count = excluded.positive_count,
      topic_count    = excluded.topic_count,
      sentiment      = excluded.sentiment,
      mood_ref       = excluded.mood_ref,
      items_json     = excluded.items_json
  `);

  for (const [cat, d] of catData.entries()) {
    const total = d.pain + d.pos + d.neutral;
    // Fraction-based formula: amplifies detected sentiment signal so that
    // ~10% pain messages → score ~1.8, ~10% positive → ~3.8.
    // Neutral messages don't pull toward 3.0 — only detected sentiment counts.
    const painFrac = d.pain / total;
    const posFrac  = d.pos  / total;
    const sentiment = Math.min(5, Math.max(1,
      3.0 + (posFrac - painFrac * 1.5) * 8,
    ));
    upsert.run(date, cat, d.pain, d.pos, d.neutral, sentiment);
  }

  const kwUpsert = db.prepare(`
    INSERT INTO narrative_keywords (date, keyword, count) VALUES (?, ?, ?)
    ON CONFLICT(date, keyword) DO UPDATE SET count = excluded.count
  `);

  let kwCount = 0;
  for (const [word, count] of wordCounts.entries()) {
    // Require ≥5 messages — raw message volume is much higher than pulse items
    if (count >= 5) {
      kwUpsert.run(date, word, count);
      kwCount++;
    }
  }

  logger.info(
    `[narrative] Processed ${date}: ${messages.length} messages → ` +
    `${catData.size} categories, ${kwCount} keywords`,
  );
}

/** Process yesterday's messages. Called by the daily cron at 01:00 CET. */
export function processYesterdayFromMessages(): void {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  try {
    const msgDb = openMsgDb();
    try {
      processDay(yesterday, msgDb);
    } finally {
      msgDb.close();
    }
  } catch (err) {
    logger.warn('[narrative] processYesterdayFromMessages failed:', err);
  }
}

// ── Backfill ───────────────────────────────────────────────────────────────────

export function reprocessNarrativeHistory(): { processed: number; errors: number } {
  const db = getDb();

  // Wipe existing derived data so stale rows from old taxonomy/stopwords don't persist
  db.prepare('DELETE FROM narrative_daily').run();
  db.prepare('DELETE FROM narrative_keywords').run();
  logger.info('[narrative] Cleared narrative tables for full reprocess');

  let msgDb: Database.Database;
  try {
    msgDb = openMsgDb();
  } catch (err) {
    logger.error('[narrative] Could not open message DB for reprocess:', err);
    return { processed: 0, errors: 1 };
  }

  // Find all distinct UTC calendar dates that have messages
  const dates = (msgDb.prepare(
    `SELECT DISTINCT date(created_at / 1000, 'unixepoch') AS d
     FROM discord_messages ORDER BY d ASC`,
  ).all() as { d: string }[]).map(r => r.d);

  let processed = 0;
  let errors = 0;

  for (const date of dates) {
    try {
      processDay(date, msgDb);
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[narrative] Failed to process ${date}: ${msg}`);
      errors++;
    }
  }

  msgDb.close();

  logger.info(`[narrative] Reprocess complete: ${processed} ok, ${errors} errors`);
  return { processed, errors };
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
             AVG(sentiment)                                   AS avg_sentiment,
             SUM(pain_count + positive_count + topic_count)   AS total_items
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
  const now  = new Date();
  const day0  = now.toISOString().slice(0, 10);
  const day7  = new Date(now.getTime() -  7 * 86_400_000).toISOString().slice(0, 10);
  const day14 = new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10);

  type AggRow = { category: string; avg_sentiment: number; total_items: number };

  const currentWeek = db.prepare(`
    SELECT category, AVG(sentiment) AS avg_sentiment,
           SUM(pain_count + positive_count + topic_count) AS total_items
    FROM narrative_daily WHERE date > ? AND date <= ? GROUP BY category
  `).all(day7, day0) as AggRow[];

  const priorWeek = db.prepare(`
    SELECT category, AVG(sentiment) AS avg_sentiment,
           SUM(pain_count + positive_count + topic_count) AS total_items
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

      // Scaled thresholds for raw message volumes (~10× more items than pulse-based)
      const bothHaveData = curr.total_items >= 80 && prior.total_items >= 150;

      if (sentDrop <= -0.3 && bothHaveData) {
        alerts.push({
          level: 'danger',
          category: curr.category,
          label,
          detail: `Sentiment ${prior.avg_sentiment.toFixed(2)} → ${curr.avg_sentiment.toFixed(2)} · vol ${volChange >= 0 ? '+' : ''}${(volChange * 100).toFixed(0)}%`,
          currentSentiment: Math.round(curr.avg_sentiment * 100) / 100,
          priorSentiment:   Math.round(prior.avg_sentiment * 100) / 100,
          volumeChange:     Math.round(volChange * 100) / 100,
        });
      } else if (volChange >= 0.5 && bothHaveData) {
        alerts.push({
          level: 'warning',
          category: curr.category,
          label,
          detail: `Volume up ${(volChange * 100).toFixed(0)}% WoW (${curr.total_items} vs ${prior.total_items} messages)`,
          currentSentiment: Math.round(curr.avg_sentiment * 100) / 100,
          priorSentiment:   Math.round(prior.avg_sentiment * 100) / 100,
          volumeChange:     Math.round(volChange * 100) / 100,
        });
      }
    }
  }

  // Emerging keywords: appeared more this week vs last
  type KwRow = { keyword: string; total: number };
  const emergingKw = db.prepare(`
    SELECT keyword, SUM(count) AS total FROM narrative_keywords
    WHERE date > ? GROUP BY keyword HAVING total >= 50 ORDER BY total DESC LIMIT 10
  `).all(day7) as KwRow[];

  const priorKw = db.prepare(`
    SELECT keyword, SUM(count) AS total FROM narrative_keywords
    WHERE date > ? AND date <= ? GROUP BY keyword
  `).all(day14, day7) as KwRow[];
  const priorKwMap = new Map(priorKw.map(k => [k.keyword, k.total]));

  for (const kw of emergingKw) {
    const priorCount = priorKwMap.get(kw.keyword) ?? 0;
    if (kw.total > priorCount * 3) {
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
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
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
  const now      = Date.now();
  const halfDays = Math.ceil(days / 2);
  const recentSince = new Date(now - halfDays * 86_400_000).toISOString().slice(0, 10);
  const allSince    = new Date(now - days   * 86_400_000).toISOString().slice(0, 10);

  type KwRow = { keyword: string; total: number };
  const recent = db.prepare(`
    SELECT keyword, SUM(count) AS total FROM narrative_keywords
    WHERE date >= ? GROUP BY keyword ORDER BY total DESC LIMIT 50
  `).all(recentSince) as KwRow[];

  const prior = db.prepare(`
    SELECT keyword, SUM(count) AS total FROM narrative_keywords
    WHERE date >= ? AND date < ? GROUP BY keyword
  `).all(allSince, recentSince) as KwRow[];
  const priorMap = new Map(prior.map(k => [k.keyword, k.total]));

  return recent
    .filter(r => r.total >= 10)
    .map(r => ({
      keyword:     r.keyword,
      recentCount: r.total,
      priorCount:  priorMap.get(r.keyword) ?? 0,
      // Thresholds scaled for raw message volumes
      heat: (r.total >= 50 ? 'hot' : r.total >= 25 ? 'warm' : 'cool') as 'hot' | 'warm' | 'cool',
    }));
}

// ── AI-informed keyword suggestions ────────────────────────────────────────────
// Compares lexicon emerging keywords with AI emerging keywords to identify:
//   - Topics the AI confirmed are real (both sources agree)
//   - Topics the AI spotted that the lexicon missed (add to categories?)
//   - Lexicon keywords the AI ignored (likely noise → add to stopwords?)
//
// Failsafe: if AI is disabled or has no data, returns empty suggestion lists.
// The lexicon continues to work normally regardless.

export interface NarrativeSuggestions {
  hasAiData:       boolean;
  confirmedByAi:   { keyword: string; lexiconCount: number; aiCount: number }[];
  missedByLexicon: { keyword: string; aiCount: number }[];
  noiseCandidates: { keyword: string; lexiconCount: number }[];
}

export function getAiSuggestedImprovements(days = 30): NarrativeSuggestions {
  const db    = getDb();
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  type KwRow = { keyword: string; total: number };

  const lexiconKws = db.prepare(`
    SELECT keyword, SUM(count) AS total FROM narrative_keywords
    WHERE date >= ? GROUP BY keyword ORDER BY total DESC LIMIT 150
  `).all(since) as KwRow[];

  // AI data is optional — gracefully absent when AI is disabled or not yet run
  let aiKws: KwRow[] = [];
  let hasAiData = false;
  try {
    const rows = db.prepare(`
      SELECT keyword, SUM(count) AS total FROM narrative_ai_keywords
      WHERE date >= ? GROUP BY keyword ORDER BY total DESC LIMIT 150
    `).all(since) as KwRow[];
    if (rows.length > 0) { aiKws = rows; hasAiData = true; }
  } catch { /* AI tables absent — not an error */ }

  if (!hasAiData) {
    return { hasAiData: false, confirmedByAi: [], missedByLexicon: [], noiseCandidates: [] };
  }

  const lexiconMap = new Map(lexiconKws.map(k => [k.keyword, k.total]));
  const aiMap      = new Map(aiKws.map(k => [k.keyword, k.total]));

  // Both sources agree — genuine community topics
  const confirmedByAi = lexiconKws
    .filter(k => aiMap.has(k.keyword))
    .map(k => ({ keyword: k.keyword, lexiconCount: k.total, aiCount: aiMap.get(k.keyword)! }))
    .sort((a, b) => b.aiCount - a.aiCount)
    .slice(0, 20);

  // AI spotted these but the lexicon didn't — possible category keyword additions
  const missedByLexicon = aiKws
    .filter(k => !lexiconMap.has(k.keyword) && k.total >= 5)
    .map(k => ({ keyword: k.keyword, aiCount: k.total }))
    .sort((a, b) => b.aiCount - a.aiCount)
    .slice(0, 20);

  // Lexicon flagged these but AI didn't agree — likely noise / stopword candidates
  const noiseCandidates = lexiconKws
    .filter(k => !aiMap.has(k.keyword) && k.total >= 15)
    .map(k => ({ keyword: k.keyword, lexiconCount: k.total }))
    .sort((a, b) => b.lexiconCount - a.lexiconCount)
    .slice(0, 20);

  return { hasAiData, confirmedByAi, missedByLexicon, noiseCandidates };
}
