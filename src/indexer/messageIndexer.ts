/**
 * Discord Message Indexer
 *
 * Real-time: listens to messageCreate on configured channels and writes
 * qualifying messages to the SQLite message index on the Hetzner volume.
 *
 * Backfill: fetches historical messages via Discord REST API and inserts
 * them into the index. Run once with `npm start -- --backfill` (defaults
 * to 7 days) or `npm start -- --backfill=720` for up to 30 days.
 *
 * Forum channels: messageCreate fires for thread messages with the thread
 * channel as message.channel. We resolve the parent forum channel ID so
 * messages are stored under the configured channel ID.
 */

import { Message } from 'discord.js';
import { getDiscordClient } from '../api/discord';
import { config } from '../config';
import { logger } from '../logger';
import { bulkInsertMessages, insertMessage, MessageRow } from '../store/messageDb';
import { isIndexable } from './messageFilter';

// ── Real-time listener ────────────────────────────────────────────────────────

export function startMessageIndexer(): void {
  const client     = getDiscordClient();
  const channelSet = new Set(config.sentimentChannelIds);

  client.on('messageCreate', (message: Message) => {
    if (message.author.bot) return;

    // For forum/text-channel threads, match against the parent channel ID
    // (which is what SENTIMENT_CHANNEL_IDS contains)
    const rootChannelId = message.channel.isThread()
      ? (message.channel.parentId ?? message.channelId)
      : message.channelId;

    if (!channelSet.has(rootChannelId)) return;
    if (!isIndexable(message.content))  return;

    insertMessage({
      message_id: message.id,
      channel_id: rootChannelId,
      author_id:  message.author.id,
      content:    message.content.trim(),
      created_at: message.createdTimestamp,
    });
  });

  logger.info(`[messageIndexer] Real-time indexer active on ${channelSet.size} channel(s)`);
}

// ── Backfill ──────────────────────────────────────────────────────────────────

/**
 * Backfill the message index from the Discord REST API.
 * Applies the same isIndexable filter so the dataset is consistent
 * with what the real-time listener would have captured.
 *
 * @param windowHours  How far back to fetch (max 720 = 30 days). Default 168 = 7 days.
 */
export async function backfillMessages(windowHours = 168): Promise<void> {
  const safeWindow = Math.min(windowHours, 720);
  logger.info(`[messageIndexer] Starting backfill (${safeWindow}h window)…`);

  const { collectMessagesForWindowFull } = await import('../collectors/messageCollector');

  const rows = await collectMessagesForWindowFull(
    config.sentimentChannelIds,
    safeWindow,
  );

  const inserted = bulkInsertMessages(rows);
  logger.info(
    `[messageIndexer] Backfill complete — collected ${rows.length}, inserted ${inserted} new messages`,
  );
}
