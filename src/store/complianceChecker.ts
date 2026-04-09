/**
 * Compliance / Tone Monitor — AI review runner.
 * Samples messages from watched users and evaluates them with gpt-5.1.
 */

import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../logger';
import {
  AiComplianceResult,
  ComplianceMessage,
  insertComplianceReview,
  sampleMessagesForReview,
} from './complianceDb';
import { getMessagesAroundTimestamp } from './messageDb';

const BATCH_SIZE = 20;

function getClient(): OpenAI {
  return new OpenAI({ apiKey: config.openAiApiKey });
}

const SYSTEM_PROMPT = `You are an internal compliance reviewer for Wargaming's World of Warships Discord server. You evaluate messages sent by Community Managers (CMs) and Moderators for adherence to the official Wargaming Community Manager Tone of Voice policy.

You are given conversational context (preceding messages from other users) so you can judge whether the staff member adequately addressed what was being discussed.

## Official Tone of Voice Policy (Wargaming / World of Warships Discord)

**Core Principles:**
- CMs represent the company — even casual interactions are official communication
- Always be polite, calm, and respectful, even under stress or provocation
- Never speculate — when in doubt, say you can't answer and escalate internally
- Never blame other departments or colleagues publicly
- Understand the server climate and emotional context before replying

**DO:**
- Be human: approachable, slightly informal, friendly
- Use player-first language (e.g. "Thanks for the heads up! We'll take a look.")
- Use emojis and GIFs moderately to match community tone
- Mirror channel tone while maintaining professionalism
- Admit when you don't know: "I'm not sure yet, but I'll check and get back to you."
- Anchor replies in your role when helpful

**AVOID:**
- Corporate speak or cold, templated responses
- Sarcasm, even if meant playfully — it doesn't always translate
- Being overly defensive or argumentative about criticism
- Public moderation or mini-modding (escalate instead)
- Speculating or making promises that can't be guaranteed

**Handling difficult questions:**
- Instead of guessing: "That's a good question — I'll flag it to the relevant team."
- "I don't want to mislead you, so I'll hold off until I'm sure."
- "That's still under discussion internally. We'll share more when it's finalised."

**Dealing with negative feedback:**
- Stay calm — you are not the target
- Don't take the bait in heated threads — de-escalate or disengage
- Acknowledge frustration: "I totally understand that this situation feels bad."
- Offer clarity, not confrontation
- Don't over-apologise or commit to fixes unless aligned internally

**Regional sensitivities (EU):**
- High expectation of transparency and mature discussion
- Feedback is often critical but detailed — acknowledge it
- Avoid historical references unless confident in context

## Evaluation Instructions

Evaluate each message against this policy. Provide:
- helpfulness_score: 1–5
    1 = completely unhelpful or refused to engage
    2 = unhelpful, vague, or dismissive
    3 = partially helpful
    4 = helpful and responsive
    5 = exemplary — goes above and beyond
- tone_score: 1–5
    1 = rude, hostile, or mocking
    2 = curt, dismissive, passive-aggressive, or sarcastic
    3 = neutral / acceptable but impersonal
    4 = friendly, professional, player-first
    5 = warm, empathetic, constructive — textbook policy compliance
- issues: array of short strings for specific violations (empty array if none)
    Examples: "sarcastic tone", "speculated about internal decisions", "public mini-modding",
    "dismissive of player concern", "corporate/cold language", "did not answer question",
    "overly defensive about criticism", "made unconfirmed promise", "condescending phrasing"
- summary: one sentence describing what the staff member did or failed to do
- flagged: true if either score ≤ 2 OR issues array has ≥ 2 items

Short acknowledgements ("ok", "thanks", emoji-only) with no evaluable content:
→ helpfulness_score=3, tone_score=3, issues=[], flagged=false, summary="Short acknowledgement — no policy concerns."

Base evaluation solely on the provided text and context. Respond with valid JSON only.`;

function buildPrompt(messages: Array<{
  msg: ComplianceMessage;
  context: { before: Array<{ author_id: string; content: string }>; after: Array<{ author_id: string; content: string }> };
}>): string {
  const blocks = messages.map((item, i) => {
    const lines: string[] = [`[${i + 1}] message_id: ${item.msg.message_id}`];

    if (item.context.before.length > 0) {
      lines.push('--- Conversation context ---');
      for (const m of item.context.before) {
        const truncated = m.content.length > 300 ? m.content.slice(0, 300) + '…' : m.content;
        lines.push(`[user ${m.author_id}]: ${truncated}`);
      }
    }

    const content = item.msg.content.length > 800
      ? item.msg.content.slice(0, 800) + '…'
      : item.msg.content;
    lines.push(`--- Staff message under review (${item.msg.display_name}, #${item.msg.channel_name}) ---`);
    lines.push(content);

    if (item.context.after.length > 0) {
      lines.push('--- Message after ---');
      for (const m of item.context.after) {
        const truncated = m.content.length > 300 ? m.content.slice(0, 300) + '…' : m.content;
        lines.push(`[user ${m.author_id}]: ${truncated}`);
      }
    }

    return lines.join('\n');
  });

  return `Evaluate the following ${messages.length} staff message(s). Return a JSON object with a single key "results" containing an array of ${messages.length} objects in the same order as the input, each with: message_id, helpfulness_score, tone_score, issues (array), summary, flagged (boolean).

${blocks.join('\n\n---\n\n')}`;
}

export async function runComplianceReview(): Promise<{
  reviewed: number;
  flagged:  number;
  errors:   number;
}> {
  const messages = sampleMessagesForReview(BATCH_SIZE);

  if (messages.length === 0) {
    logger.info('[compliance] No messages to review');
    return { reviewed: 0, flagged: 0, errors: 0 };
  }

  logger.info(`[compliance] Starting AI review of ${messages.length} messages`);

  // Fetch context for each message
  const withContext = messages.map(msg => {
    try {
      const context = getMessagesAroundTimestamp(msg.channel_id, msg.created_at, 3, 1);
      return { msg, context };
    } catch {
      return { msg, context: { before: [], after: [] } };
    }
  });

  let reviewed = 0;
  let flagged = 0;
  let errors = 0;

  // Process in one batch (max 20)
  try {
    const client = getClient();
    const response = await client.chat.completions.create({
      model:           'gpt-5.1',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildPrompt(withContext) },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? '{}';
    let results: AiComplianceResult[] = [];

    try {
      const parsed = JSON.parse(raw) as { results?: unknown[] };
      if (Array.isArray(parsed.results)) {
        results = parsed.results as AiComplianceResult[];
      }
    } catch {
      logger.error('[compliance] Failed to parse AI response JSON');
      return { reviewed: 0, flagged: 0, errors: messages.length };
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      const result = results[i];

      if (!result || typeof result.helpfulness_score !== 'number' || typeof result.tone_score !== 'number') {
        logger.warn(`[compliance] Missing/invalid result for message ${msg.message_id}`);
        errors++;
        continue;
      }

      const review: AiComplianceResult = {
        message_id:        msg.message_id,
        helpfulness_score: Math.min(5, Math.max(1, Math.round(result.helpfulness_score))),
        tone_score:        Math.min(5, Math.max(1, Math.round(result.tone_score))),
        issues:            Array.isArray(result.issues) ? result.issues as string[] : [],
        summary:           typeof result.summary === 'string' ? result.summary : '',
        flagged:           Boolean(result.flagged),
      };

      try {
        insertComplianceReview(review);
        reviewed++;
        if (review.flagged) flagged++;
      } catch (err) {
        logger.error(`[compliance] Failed to insert review for ${msg.message_id}:`, err);
        errors++;
      }
    }
  } catch (err) {
    logger.error('[compliance] OpenAI call failed:', err);
    return { reviewed: 0, flagged: 0, errors: messages.length };
  }

  logger.info(`[compliance] Review complete: ${reviewed} reviewed, ${flagged} flagged, ${errors} errors`);
  return { reviewed, flagged, errors };
}
