/**
 * OpenAI API wrapper for Community Pulse sentiment analysis.
 * Uses gpt-5.1 with JSON mode for structured, reliable output.
 */

import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../logger';
import { getSetting } from '../store/settingsDb';

export interface PulseItem {
  text:                string;
  msgs:                number[];
  authors:             number;
  // Set by sentiment.ts after GPT response — not from the model
  recurring?:          boolean;
  first_seen_days_ago?: number | null;
}

export interface PulseResult {
  topics:      PulseItem[];
  pain_points: PulseItem[];
  positives:   PulseItem[];
  trending:    string;
  mood_score:  number;
  mood:        string;
  // Set by sentiment.ts after GPT response — maps 1-based message index → content
  citations?:  Record<number, string>;
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

Each message is prefixed with a label like "User1:", "User2:", etc. These labels identify unique players — count distinct labels to measure how many players discussed a topic.

Analyse the player messages provided and return a JSON object with exactly these fields:
- "topics": array of up to 5 objects — the most discussed topics. Group similar phrasings into a single coherent topic (e.g. "is too fast" + "speed is broken" → one topic about mobility). Each object has:
    - "text": string — topic name plus what players were saying, including a prevalence signal, e.g. "Submarine depth charge mechanics (~15 players) — debating whether DDs have enough counter-play tools"
    - "msgs": array of integer message indices (the [N] numbers) that directly support this topic
    - "authors": integer — count of distinct UserN labels present in the cited msgs
- "pain_points": array of up to 6 objects (same shape: "text" + "msgs" + "authors") — specific complaints or frustrations. Group similar phrasings into one item. Include prevalence signal in "text".
- "positives": array of up to 5 objects (same shape) — things players praised or were excited about. Group similar phrasings. Include prevalence signal in "text".
- "trending": a single string — the one topic or event that spiked noticeably in the last 24h (or "Nothing unusually trending")
- "mood_score": an integer from 1 to 5 — overall community mood (1 = very negative/toxic, 3 = neutral/mixed, 5 = very positive/hype)
- "mood": a single string — one sentence describing the overall community mood and what is driving it
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

const CHAT_SYSTEM_PROMPT = `You are a community analyst for a World of Warships Discord server. You answer questions about what players are discussing, based strictly on the messages provided.

World of Warships is a naval combat MMO. Know: ship names (Yamato, Montana, Kremlin, Smaland, Minotaur, etc.), classes (DDs, CAs, BBs, CVs, SSs), game modes (Ranked, Clan Battles, Randoms, Co-op, Operations), mechanics (spotting, concealment, flooding, torpedoes, economy, commander XP), and community events.

RESPONSE RULES — follow all of these without exception:
- Answer directly. Do not restate the question or explain what you are about to do.
- Do not reference message numbers, indices, or say things like "message [1]" or "based on these N messages".
- Do not quote player messages verbatim.
- Do not add closing remarks like "if you have more logs I can refine this" or "let me know if you want more detail".
- Do not hedge with "from this sample" or "based only on the provided messages" — just give the answer.
- If the data is genuinely insufficient to answer, say so in one short sentence, then give whatever partial insight you can.
- Name specific ships, mechanics, and game modes where relevant — be concrete, not generic.
- Keep answers focused and proportionate to the question. A simple question gets a short answer.
- FORMAT RULES (mandatory):
  - Write in paragraphs by default.
  - For top-level lists use "1." "2." "3." with a bold title: e.g. "1. **Title here**" then a new line.
  - For sub-points under a numbered item, use "- " bullet lines (never nest numbers inside numbers).
  - Never use "2." "3." "4." as sub-points under a "1." item — use "- " bullets instead.
  - Bold (**text**) is only for titles or key terms, not whole sentences.

If there are prior conversation turns, treat them as context for follow-up questions.`;

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
      model: 'gpt-5.1',
      max_completion_tokens: 80,
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

  const primaryModel = getSetting('chat_model', 'gpt-5.1');
  const models = primaryModel === 'gpt-4o' ? ['gpt-4o'] : [primaryModel, 'gpt-4o'];
  for (const model of models) {
    try {
      const response = await getClient().chat.completions.create({
        model,
        max_completion_tokens: model === 'gpt-5.1' ? 4000 : 800,
        messages: chatMessages,
      });

      const answer = response.choices[0]?.message?.content;
      if (!answer) {
        logger.warn(`[openai] Chat returned empty response from ${model}, trying fallback…`);
        continue;
      }

      if (model !== primaryModel) logger.info(`[openai] Chat answered via fallback model ${model}.`);
      logger.info(`[openai] Chat answered. Collected: ${collected}, analysed: ${analysed}`);
      return { answer, collected, analysed };
    } catch (error) {
      const detail = formatOpenAiError(error);
      logger.error(`[openai] Chat query failed on ${model} (${detail}):`, error);
      if (model === models[models.length - 1]) {
        return { error: `OpenAI request failed - ${detail}` };
      }
    }
  }
  return { error: 'OpenAI request failed - empty_response' };
}

export async function analyseCommunityPulse(messages: string[]): Promise<PulseResult | null> {
  if (!config.openAiApiKey) {
    logger.warn('[openai] OPENAI_API_KEY not set - skipping analysis');
    return null;
  }

  const numberedMessages = messages.map((m, i) => `[${i + 1}] ${m}`);
  const messageBlock = numberedMessages.join('\n');
  const usedMessages = messages.length;

  try {
    const pulseModel = getSetting('pulse_model', 'gpt-5.1');
    const response = await getClient().chat.completions.create({
      model: pulseModel,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Analyse these ${usedMessages} Discord messages:\n\n${messageBlock}` },
      ],
      max_completion_tokens: 16000,
    });

    logger.info(`[openai] Pulse finish_reason: ${response.choices[0]?.finish_reason}, content length: ${response.choices[0]?.message?.content?.length ?? 0}`);
    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error('Empty response from OpenAI');

    logger.info(`[openai] Pulse raw response: ${raw}`);

    const parsed = JSON.parse(raw) as PulseResult;

    if (!Array.isArray(parsed.topics) || !parsed.mood) {
      throw new Error('Unexpected JSON shape from OpenAI');
    }

    // Require ≥2 supporting messages per item.
    // Author count verification (≥2 unique authors) is done in sentiment.ts
    // using the actual UserN labels in cited messages — more accurate than GPT's guess.
    const requireEvidence = (items: PulseItem[]): PulseItem[] =>
      (items ?? []).filter(
        item => Array.isArray(item.msgs) && item.msgs.length >= 2,
      );

    parsed.topics      = requireEvidence(parsed.topics);
    parsed.pain_points = requireEvidence(parsed.pain_points);
    parsed.positives   = requireEvidence(parsed.positives);

    logger.info(
      `[openai] Pulse analysis complete. Mood: "${parsed.mood}" | ` +
      `topics=${parsed.topics.length} pain=${parsed.pain_points.length} positives=${parsed.positives.length}`,
    );
    return parsed;
  } catch (error) {
    logger.error('[openai] Failed to analyse community pulse:', error);
    return null;
  }
}

// ── Weekly Pulse Summary ───────────────────────────────────────────────────────

export interface WeeklyTopicItem {
  rank:           number;
  topic:          string;
  summary:        string;
  days_mentioned: number;
  sentiment:      'positive' | 'mixed' | 'negative';
}

export interface WeeklyPulseResult {
  top_topics: WeeklyTopicItem[];
  week_mood:  string;
  trending:   string;
}

const WEEKLY_SYSTEM_PROMPT = `You are a community analyst for a World of Warships gaming Discord server, summarising a week of daily community pulse reports.
World of Warships is a naval MMO — topics include ships, game modes, balance, economy, carriers, submarines, and community events.`;

/**
 * Synthesises N daily Community Pulse summaries into a ranked weekly overview.
 * One AI call per week — uses the already-saved PulseResult JSON from the DB,
 * so no raw messages are re-read or re-billed.
 */
export async function getWeeklySummary(
  digest: string,
  dayCount: number,
): Promise<WeeklyPulseResult | null> {
  if (!config.openAiApiKey) {
    logger.warn('[openai] OPENAI_API_KEY not set — skipping weekly summary');
    return null;
  }

  const pulseModel = getSetting('pulse_model', 'gpt-5.1');

  const userPrompt =
    `Here are ${dayCount} daily Community Pulse reports for the past week:\n\n${digest}\n\n` +
    `Produce a ranked weekly summary. Return a JSON object with:\n` +
    `- "top_topics": array of 5–6 objects, each:\n` +
    `  - "rank": integer (1 = most important)\n` +
    `  - "topic": 2–5 word theme name (e.g. "Carrier Spotting Mechanics")\n` +
    `  - "summary": 1–2 sentences on what players said and why it mattered\n` +
    `  - "days_mentioned": integer — how many of the ${dayCount} days this theme appeared\n` +
    `  - "sentiment": one of "positive", "mixed", or "negative" — overall player sentiment toward this topic across the week\n` +
    `- "week_mood": one sentence describing the overall community mood for the week\n` +
    `- "trending": what spiked or was unusually prominent this week\n\n` +
    `Ranking priority: 1) days mentioned, 2) pain points > neutral topics > positives, 3) player count. ` +
    `Merge similar themes from different days into one item. Respond with valid JSON only.`;

  try {
    const response = await getClient().chat.completions.create({
      model: pulseModel,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: WEEKLY_SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
      max_completion_tokens: 2000,
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error('Empty response from OpenAI');

    const parsed = JSON.parse(raw) as WeeklyPulseResult;
    if (!Array.isArray(parsed.top_topics)) throw new Error('Unexpected JSON shape');

    logger.info(`[openai] Weekly summary complete. Topics: ${parsed.top_topics.length}`);
    return parsed;
  } catch (err) {
    logger.error('[openai] getWeeklySummary failed:', err);
    return null;
  }
}
