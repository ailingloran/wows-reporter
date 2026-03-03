/**
 * OpenAI API wrapper for Community Pulse sentiment analysis.
 * Uses gpt-4o-mini with JSON mode for structured, reliable output.
 */

import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../logger';

export interface PulseResult {
  topics:      string[];  // top 3 most discussed topics
  pain_points: string[];  // up to 3 complaints / pain points
  positives:   string[];  // up to 2 positive highlights
  mood:        string;    // one-sentence overall community mood
}

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: config.openAiApiKey });
  return _client;
}

const SYSTEM_PROMPT = `You are a community analyst for a World of Warships gaming Discord server.
Analyse the player messages provided and return a JSON object with exactly these fields:
- "topics": array of exactly 3 strings — the most discussed game-related topics (max 12 words each)
- "pain_points": array of 1–3 strings — main complaints or frustrations (max 15 words each)
- "positives": array of 1–2 strings — positive highlights or things players praised (max 15 words each)
- "mood": a single string — one sentence describing the overall community mood

Rules:
- Focus only on game-related discussion; ignore greetings, off-topic chat, and spam
- If a category has nothing meaningful to report, use a short placeholder like "Nothing notable"
- Keep all text concise and factual — no fluff
- Respond with valid JSON only, no extra text`;

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
      max_tokens: 400,
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
