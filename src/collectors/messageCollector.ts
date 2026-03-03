/**
 * Message Collector
 * Fetches all messages from the last 24 hours from configured Discord channels.
 * Paginates Discord's REST API in batches of 100 until messages fall outside
 * the 24-hour window. A safety cap of 2000 messages per channel prevents
 * runaway API calls on extremely active servers.
 */

import { Collection, Message, TextChannel } from 'discord.js';
import { getDiscordClient } from '../api/discord';
import { logger } from '../logger';

const BATCH_SIZE   = 100;   // Discord API maximum per request
const SAFETY_CAP   = 2000;  // max messages per channel (guards against huge channels)
const WINDOW_MS    = 24 * 60 * 60 * 1000;  // 24 hours in milliseconds

/**
 * Collect all non-bot messages posted in the last 24 hours across the given channels.
 * Channels that are inaccessible or not text channels are silently skipped.
 * Returns a flat array of message content strings.
 */
export async function collectRecentMessages(channelIds: string[]): Promise<string[]> {
  const client  = getDiscordClient();
  const cutoff  = Date.now() - WINDOW_MS;
  const all: string[] = [];

  for (const channelId of channelIds) {
    try {
      const channel = await client.channels.fetch(channelId);

      if (!channel || !channel.isTextBased()) {
        logger.warn(`[messageCollector] Channel ${channelId} not found or not text — skipping`);
        continue;
      }

      const textChannel  = channel as TextChannel;
      const channelMsgs: string[] = [];
      let   lastId: string | undefined;
      let   reachedCutoff = false;

      while (!reachedCutoff && channelMsgs.length < SAFETY_CAP) {
        const options: { limit: number; before?: string } = { limit: BATCH_SIZE };
        if (lastId) options.before = lastId;

        const batch: Collection<string, Message> = await textChannel.messages.fetch(options);
        if (batch.size === 0) break;

        for (const msg of batch.values()) {
          if (msg.createdTimestamp < cutoff) {
            reachedCutoff = true;
            break;
          }
          if (!msg.author.bot && msg.content.length >= 5) {
            channelMsgs.push(msg.content.trim());
          }
        }

        // The batch is sorted newest → oldest; the last entry is the oldest
        lastId = batch.last()?.id;
        if (!lastId) break;
      }

      logger.debug(`[messageCollector] ${channelMsgs.length} messages from channel ${channelId} (last 24h)`);
      all.push(...channelMsgs);

    } catch (err) {
      logger.warn(`[messageCollector] Failed to fetch messages from channel ${channelId}:`, err);
    }
  }

  logger.info(`[messageCollector] Total: ${all.length} messages across ${channelIds.length} channel(s) in the last 24h`);
  return all;
}
