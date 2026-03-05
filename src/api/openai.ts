/**
 * OpenAI API wrapper for Community Pulse sentiment analysis.
 * Uses gpt-4o-mini with JSON mode for structured, reliable output.
 */

import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../logger';

export interface PulseResult {
  topics:      string[];  // top 5 most discussed topics (specific — ship names, mechanics, modes)
  pain_points: string[];  // up to 4 complaints / pain points
  positives:   string[];  // up to 3 positive highlights
  trending:    string;    // what spiked specifically in the last 24h
  mood_score:  number;    // overall mood 1 (very negative) to 5 (very positive)
  mood:        string;    // one-sentence overall community mood
}

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: config.openAiApiKey });
  return _client;
}

const SYSTEM_PROMPT = `You are a community analyst for a World of Warships gaming Discord server.
World of Warships is a naval combat MMO. Common topics include: specific ships (e.g. Kremlin, Yamato, Smaland), ship classes (destroyers/DDs, cruisers/CAs, battleships/BBs, carriers/CVs, submarines/SSs), game modes (Ranked, Clan Battles, Operations, Co-op, Random), mechanics (spotting, concealment, flooding, fire, torpedoes, CV rework, economy, credits, dockyard), balance/meta shifts, recent patches or updates, and community events.

Analyse the player messages provided and return a JSON object with exactly these fields:
- "topics": array of up to 5 strings — the most discussed topics. Each string must include the topic name AND a brief explanation of what players were actually saying about it, separated by " — ". Example: "Submarine depth charge mechanics — players debating whether DDs have enough tools to counter subs" not just "Submarine mechanics"
- "pain_points": array of 1–4 strings — main complaints or frustrations players expressed. Be specific about what exactly they are unhappy about
- "positives": array of 1–3 strings — things players praised or reacted positively to. Be specific
- "trending": a single string — what topic or event spiked noticeably in the last 24h compared to background noise (or "Nothing unusually trending" if nothing stands out)
- "mood_score": an integer from 1 to 5 — overall community mood (1 = very negative/toxic, 3 = neutral/mixed, 5 = very positive/hype)
- "mood": a single string — one sentence describing the overall community mood with specific colour, e.g. mention what is driving it

Rules:
- Always name specific ships, mechanics, patches, or game modes — never say "balance issues" when you can say "Smaland torpedo reload nerf"
- Ignore greetings, memes, off-topic chat, and one-word messages
- If a category has nothing meaningful to report, use "Nothing notable"
- Respond with valid JSON only, no extra text`;

// ── Chat / Q&A ────────────────────────────────────────────────────────────────

const MAX_AI_MESSAGES = 4_500; // hard context-window safety cap

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

Answer the question based only on what is present in the provided messages. Be specific — name actual ships, game modes, or mechanics where relevant. If the messages do not contain enough information to answer confidently, say so clearly. Keep your answer concise and factual.`;

export interface ChatResult {
  answer:    string;
  collected: number;
  analysed:  number;
}

export async function answerQuestion(
  messages: string[],
  question: string,
): Promise<ChatResult | null> {
  if (!config.openAiApiKey) {
    logger.warn('[openai] OPENAI_API_KEY not set — skipping chat');
    return null;
  }

  const collected  = messages.length;
  const toAnalyse  = collected > MAX_AI_MESSAGES
    ? shuffleSample(messages, MAX_AI_MESSAGES)
    : messages;
  const analysed   = toAnalyse.length;
  const messageBlock = toAnalyse.map((m, i) => `[${i + 1}] ${m}`).join('\n');

  try {
    const response = await getClient().chat.completions.create({
      model:       'gpt-4o-mini',
      temperature: 0.4,
      max_tokens:  800,
      messages: [
        { role: 'system', content: CHAT_SYSTEM_PROMPT },
        {
          role:    'user',
          content: `Here are ${analysed} Discord messages:\n\n${messageBlock}\n\nQuestion: ${question}`,
        },
      ],
    });

    const answer = response.choices[0]?.message?.content;
    if (!answer) throw new Error('Empty response from OpenAI');

    logger.info(`[openai] Chat answered. Collected: ${collected}, analysed: ${analysed}`);
    return { answer, collected, analysed };
  } catch (err) {
    logger.error('[openai] Chat query failed:', err);
    return null;
  }
}

// ── Community Pulse ───────────────────────────────────────────────────────────

export async function analyseCommunityPulse(messages: string[]): Promise<PulseResult | null> {
  if (!config.openAiApiKey) {
    logger.warn('[openai] OPENAI_API_KEY not set — skipping analysis');
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
        { role: 'user',   content: `Analyse these ${messages.length} Discord messages:\n\n${messageBlock}` },
      ],
      max_tokens: 700,
      temperature: 0.3,
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error('Empty response from OpenAI');

    const parsed = JSON.parse(raw) as PulseResult;

    // Basic validation
    if (!Array.isArray(parsed.topics) || !parsed.mood) {
      throw new Error('Unexpected JSON shape from OpenAI');
    }

    logger.info(`[openai] Pulse analysis complete. Mood: "${parsed.mood}"`);
    return parsed;
  } catch (err) {
    logger.error('[openai] Failed to analyse community pulse:', err);
    return null;
  }
}
