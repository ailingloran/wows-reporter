/**
 * Message Collector
 * Fetches recent messages from configured Discord channels for sentiment analysis.
 */

import { TextChannel } from 'discord.js';
import { getDiscordClient } from '../api/discord';
import { logger } from '../logger';

/**
 * Fetch up to `limitPerChannel` recent non-bot messages from each channel ID.
 * Channels that are inaccessible or not text channels are silently skipped.
 * Returns a flat array of message content strings.
 */
export async function collectRecentMessages(
  channelIds: string[],
  limitPerChannel: number,
): Promise<string[]> {
  const client   = getDiscordClient();
  const messages: string[] = [];

  for (const channelId of channelIds) {
    try {
      const channel = await client.channels.fetch(channelId);

      if (!channel || !channel.isTextBased()) {
        logger.warn(`[messageCollector] Channel ${channelId} not found or not a text channel — skipping`);
        continue;
      }

      const fetched = await (channel as TextChannel).messages.fetch({ limit: Math.min(limitPerChannel, 100) });

      const contents = fetched
        .filter(m => !m.author.bot && m.content.length >= 5)
        .map(m => m.content.trim());

      messages.push(...contents);
      logger.debug(`[messageCollector] Fetched ${contents.length} messages from ${channelId}`);
    } catch (err) {
      logger.warn(`[messageCollector] Failed to fetch messages from channel ${channelId}:`, err);
    }
  }

  logger.info(`[messageCollector] Total messages collected: ${messages.length} across ${channelIds.length} channel(s)`);
  return messages;
}
