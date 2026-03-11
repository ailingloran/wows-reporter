/**
 * OpenAI API wrapper for Community Pulse sentiment analysis.
 * Uses gpt-4o-mini with JSON mode for structured, reliable output.
 */

import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../logger';

export interface PulseItem {
  text:                string;
  msgs:                number[];
  authors:             number;
  // Set by sentiment.ts after GPT response — not from the model
  recurring?:          boolean;
  first_seen_days_ago?: number | null;
}

export interface PulseResult {
  topics:           PulseItem[];
  pain_points:      PulseItem[];
  positives:        PulseItem[];
  trending:         string;
  mood_score:       number;
  mood:             string;
  minority_insight: PulseItem | null;
  // Set by sentiment.ts after GPT response — maps 1-based message index → content
  citations?:       Record<number, string>;
}

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: config.openAiApiKey });
  return _client;
}

function formatOpenAiError(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return 'unknown_error';
  }

  const data = error as {
    code?: unknown;
    status?: unknown;
    type?: unknown;
    message?: unknown;
    error?: { code?: unknown; type?: unknown; message?: unknown };
  };

  const nested = data.error;
  const parts = [
    typeof data.code === 'string' ? data.code : null,
    typeof nested?.code === 'string' ? nested.code : null,
    typeof data.type === 'string' ? data.type : null,
    typeof nested?.type === 'string' ? nested.type : null,
    typeof data.status === 'number' ? `status_${data.status}` : null,
    typeof data.message === 'string' ? data.message : null,
    typeof nested?.message === 'string' ? nested.message : null,
  ].filter((part, index, arr): part is string => !!part && arr.indexOf(part) === index);

  return parts[0] ?? 'unknown_error';
}

const SYSTEM_PROMPT = `You are a community analyst for a World of Warships gaming Discord server.
World of Warships is a naval combat MMO. Common topics include: specific ships (e.g. Kremlin, Yamato, Smaland), ship classes (destroyers/DDs, cruisers/CAs, battleships/BBs, carriers/CVs, submarines/SSs), game modes (Ranked, Clan Battles, Operations, Co-op, Random), mechanics (spotting, concealment, flooding, fire, torpedoes, CV rework, economy, credits, dockyard), balance/meta shifts, recent patches or updates, and community events.

Analyse the player messages provided and return a JSON object with exactly these fields:
- "topics": array of up to 5 objects — the most discussed topics. Group similar phrasings into a single coherent topic (e.g. "is too fast" + "speed is broken" → one topic about mobility). Each object has:
    - "text": string — topic name plus what players were saying, including a prevalence signal, e.g. "Submarine depth charge mechanics (~15 players) — debating whether DDs have enough counter-play tools"
    - "msgs": array of integer message indices (the [N] numbers) that directly support this topic
    - "authors": integer — number of unique authors whose messages support this topic
- "pain_points": array of 1-4 objects (same shape: "text" + "msgs" + "authors") — specific complaints or frustrations. Group similar phrasings into one item. Include prevalence signal in "text".
- "positives": array of 1-3 objects (same shape) — things players praised or were excited about. Group similar phrasings. Include prevalence signal in "text".
- "trending": a single string — the one topic or event that spiked noticeably in the last 24h (or "Nothing unusually trending")
- "mood_score": an integer from 1 to 5 — overall community mood (1 = very negative/toxic, 3 = neutral/mixed, 5 = very positive/hype)
- "mood": a single string — one sentence describing the overall community mood and what is driving it
- "minority_insight": an object OR null — a single high-quality, well-reasoned comment worth surfacing even though it comes from only one author. Must have:
    - "text": string — brief analytical description of what was said and why it is insightful (do NOT quote verbatim)
    - "msgs": array containing the single supporting message index
    - "authors": 1
  Set "minority_insight" to null if no such standout comment exists.

STRICT EVIDENCE RULES — these are mandatory, not suggestions:
- ONLY report what is explicitly and directly stated in the messages. Do not infer, extrapolate, or speculate
- Every item in "topics", "pain_points", and "positives" MUST have at least 2 different message indices in "msgs" AND "authors" ≥ 2. Omit any item that does not meet both thresholds
- NEVER name specific game changes (nerfs, buffs, reworks, patches) unless players explicitly name them in the messages
- Describe only what players actually said — use the exact ships, mechanics, and game modes they named
- Ignore greetings, memes, off-topic chat, and one-word messages
- Do NOT quote player messages verbatim — describe what was said in your own analytical words
- If a category has no qualifying items, return an empty array [] — do not fabricate content
- Respond with valid JSON only, no extra text`;

const MAX_AI_MESSAGES = 4_500;

function shuffleSample<T>(arr: T[], n: number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

const CHAT_SYSTEM_PROMPT = `You are an analyst for a World of Warships gaming Discord server with access to a sample of recent player messages.

World of Warships is a naval combat MMO. Be familiar with: ship names (Yamato, Montana, Kremlin, Smaland, Minotaur, etc.), ship classes (DDs/destroyers, CAs/cruisers, BBs/battleships, CVs/carriers, SSs/submarines), game modes (Ranked, Clan Battles, Random Battles, Co-op, Operations), mechanics (spotting, concealment, flooding, fire, torpedoes, dispersion, economy, commander XP), and community events.

Answer the question based only on what is present in the provided messages. Be specific - name actual ships, game modes, or mechanics where relevant. If the messages do not contain enough information to answer confidently, say so clearly. Keep your answer concise and factual.

If there are prior conversation turns, treat them as context for follow-up questions. You may reference your previous answers.`;

export interface ChatResult {
  answer: string;
  collected: number;
  analysed: number;
}

export interface ChatFailure {
  error: string;
}

export interface SessionTurn {
  question: string;
  answer:   string;
}

// ── Keyword extraction (first pass for FTS5 chat search) ─────────────────────

const STOP_WORDS = new Set([
  'what', 'how', 'when', 'where', 'why', 'who', 'which', 'are', 'is',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'been',
  'they', 'their', 'about', 'would', 'could', 'should', 'were', 'will',
  'can', 'did', 'does', 'into', 'your', 'you', 'our', 'more', 'like',
  'than', 'think', 'players', 'player', 'say', 'says', 'said', 'feel',
  'feels', 'tell', 'give', 'make', 'take', 'want', 'need', 'there',
  'some', 'other', 'most', 'much', 'many', 'very', 'just', 'also',
  'only', 'but', 'not', 'all', 'any', 'its', 'it', 'be', 'has', 'do',
  'an', 'we', 'in', 'on', 'to', 'of', 'at', 'by',
]);

function basicKeywords(question: string): string[] {
  return [...new Set(
    question
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w)),
  )];
}

function sanitizeFtsKeywords(words: string[]): string {
  return words
    .map(k => k.replace(/["*()\-^:]/g, ' ').trim())
    .filter(k => k.length >= 2)
    .join(' OR ');
}

/**
 * Use GPT to extract relevant FTS5 search keywords from a question.
 * Returns an FTS5 OR query string (e.g., "submarine OR torpedo OR destroyer").
 * Falls back to stop-word-based extraction if the API is unavailable.
 */
export async function extractKeywordsForSearch(question: string): Promise<string> {
  const fallback = sanitizeFtsKeywords(basicKeywords(question));

  if (!config.openAiApiKey) return fallback;

  try {
    const response = await getClient().chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 80,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are a search query builder for a World of Warships Discord community database. ' +
            'Extract the most important search terms from the user\'s question. ' +
            'Return ONLY a JSON object: {"keywords": ["word1", "word2", ...]}. ' +
            'Include specific ship names, game mechanics, modes, and relevant nouns. ' +
            '3-8 keywords, no stop words, no punctuation inside keywords.',
        },
        { role: 'user', content: question },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw) as { keywords?: unknown };
    const kws = Array.isArray(parsed.keywords)
      ? (parsed.keywords as unknown[]).filter((k): k is string => typeof k === 'string')
      : [];

    if (kws.length === 0) return fallback;
    return sanitizeFtsKeywords(kws);
  } catch {
    return fallback;
  }
}

export async function answerQuestion(
  messages: string[],
  question: string,
  priorTurns: SessionTurn[] = [],
): Promise<ChatResult | ChatFailure> {
  if (!config.openAiApiKey) {
    logger.warn('[openai] OPENAI_API_KEY not set - skipping chat');
    return { error: 'OpenAI request failed - missing_api_key' };
  }

  const collected = messages.length;
  const toAnalyse = collected > MAX_AI_MESSAGES
    ? shuffleSample(messages, MAX_AI_MESSAGES)
    : messages;
  const analysed = toAnalyse.length;
  const messageBlock = toAnalyse.map((m, i) => `[${i + 1}] ${m}`).join('\n');

  // Build conversation messages: system + prior turns + current question
  const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
  ];

  // Inject prior session turns as conversation history (without re-sending the message block)
  for (const turn of priorTurns) {
    chatMessages.push({ role: 'user', content: turn.question });
    chatMessages.push({ role: 'assistant', content: turn.answer });
  }

  // Current question includes the fresh message block
  chatMessages.push({
    role: 'user',
    content: `Here are ${analysed} Discord messages:\n\n${messageBlock}\n\nQuestion: ${question}`,
  });

  try {
    const response = await getClient().chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      max_tokens: 800,
      messages: chatMessages,
    });

    const answer = response.choices[0]?.message?.content;
    if (!answer) throw new Error('empty_response');

    logger.info(`[openai] Chat answered. Collected: ${collected}, analysed: ${analysed}`);
    return { answer, collected, analysed };
  } catch (error) {
    const detail = formatOpenAiError(error);
    logger.error(`[openai] Chat query failed (${detail}):`, error);
    return { error: `OpenAI request failed - ${detail}` };
  }
}

export async function analyseCommunityPulse(messages: string[]): Promise<PulseResult | null> {
  if (!config.openAiApiKey) {
    logger.warn('[openai] OPENAI_API_KEY not set - skipping analysis');
    return null;
  }

  const messageBlock = messages
    .map((m, i) => `[${i + 1}] ${m}`)
    .join('\n');

  try {
    const response = await getClient().chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Analyse these ${messages.length} Discord messages:\n\n${messageBlock}` },
      ],
      max_tokens: 1200,
      temperature: 0.3,
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error('Empty response from OpenAI');

    const parsed = JSON.parse(raw) as PulseResult;

    if (!Array.isArray(parsed.topics) || !parsed.mood) {
      throw new Error('Unexpected JSON shape from OpenAI');
    }

    // Drop any item that doesn't have ≥2 supporting messages from ≥2 unique authors.
    // This is our primary anti-hallucination guard.
    const requireEvidence = (items: PulseItem[]): PulseItem[] =>
      (items ?? []).filter(
        item =>
          Array.isArray(item.msgs) &&
          item.msgs.length >= 2 &&
          typeof item.authors === 'number' &&
          item.authors >= 2,
      );

    parsed.topics      = requireEvidence(parsed.topics);
    parsed.pain_points = requireEvidence(parsed.pain_points);
    parsed.positives   = requireEvidence(parsed.positives);

    // Validate minority_insight shape if present (1 author is allowed)
    if (
      parsed.minority_insight &&
      (!Array.isArray(parsed.minority_insight.msgs) || parsed.minority_insight.msgs.length === 0)
    ) {
      parsed.minority_insight = null;
    }

    logger.info(
      `[openai] Pulse analysis complete. Mood: "${parsed.mood}" | ` +
      `topics=${parsed.topics.length} pain=${parsed.pain_points.length} positives=${parsed.positives.length}` +
      (parsed.minority_insight ? ' | minority_insight=1' : ''),
    );
    return parsed;
  } catch (error) {
    logger.error('[openai] Failed to analyse community pulse:', error);
    return null;
  }
}
