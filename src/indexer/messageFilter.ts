/**
 * Message quality filter for the Discord message index.
 * Shared by the real-time indexer and the backfill collector.
 */

import { config } from '../config';

const DISCORD_CUSTOM_EMOJI = /<a?:\w+:\d+>/g;
const UNICODE_EMOJI         = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
const URL                   = /https?:\/\/\S+/g;

/**
 * Returns true if a message is worth indexing:
 * - Long enough (config.minIndexMessageLength chars)
 * - Has enough real words (config.minIndexWordCount) after stripping emojis + URLs
 * - Is not purely emoji/link content
 */
export function isIndexable(content: string): boolean {
  if (content.length < config.minIndexMessageLength) return false;

  const stripped = content
    .replace(DISCORD_CUSTOM_EMOJI, '')
    .replace(UNICODE_EMOJI, '')
    .replace(URL, '')
    .trim();

  // After stripping, must still have meaningful text
  if (stripped.length < 10) return false;

  const wordCount = stripped.split(/\s+/).filter(w => w.length > 0).length;
  return wordCount >= config.minIndexWordCount;
}
