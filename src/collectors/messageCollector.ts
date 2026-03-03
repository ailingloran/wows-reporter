/**
 * Message Collector
 * Fetches all messages from the last 24 hours from configured Discord channels.
 * Supports both regular text channels and forum channels.
 * - Text channels: paginates REST API in batches of 100 until outside the window.
 * - Forum channels: reads all active threads + recently archived threads, then
 *   collects messages from each thread within the 24h window.
 * A safety cap of 2000 messages per source prevents runaway API calls.
 */

import { ChannelType, Collection, Message, TextChannel, AnyThreadChannel, GuildForumChannel } from 'discord.js';
import { getDiscordClient } from '../api/discord';
import { logger } from '../logger';

const BATCH_SIZE = 100;   // Discord API maximum per fetch request
const SAFETY_CAP = 2000;  // max messages per channel/thread
const WINDOW_MS  = 24 * 60 * 60 * 1000;  // 24 hours in milliseconds

// ── Core pagination helper ────────────────────────────────────────────────────

/**
 * Read up to SAFETY_CAP messages from a single text-based channel or thread,
 * stopping when messages fall outside the 24h window.
 */
async function readMessagesFrom(channel: TextChannel | AnyThreadChannel, cutoff: number): Promise<string[]> {
  const results: string[] = [];
  let lastId: string | undefined;
  let reachedCutoff = false;

  while (!reachedCutoff && results.length < SAFETY_CAP) {
    const options: { limit: number; before?: string } = { limit: BATCH_SIZE };
    if (lastId) options.before = lastId;

    const batch: Collection<string, Message> = await channel.messages.fetch(options);
    if (batch.size === 0) break;

    for (const msg of batch.values()) {
      if (msg.createdTimestamp < cutoff) {
        reachedCutoff = true;
        break;
      }
      if (!msg.author.bot && msg.content.length >= 5) {
        results.push(msg.content.trim());
      }
    }

    lastId = batch.last()?.id;
    if (!lastId) break;
  }

  return results;
}

// ── Forum channel handler ─────────────────────────────────────────────────────

/**
 * Collect messages from all threads in a forum channel that had activity
 * in the last 24 hours (active threads + recently archived threads).
 */
async function readForumChannel(forum: GuildForumChannel, cutoff: number): Promise<string[]> {
  const results: string[] = [];

  // 1. Active threads (all open posts, regardless of age)
  const { threads: activeThreads } = await forum.threads.fetchActive();
  logger.debug(`[messageCollector] Forum ${forum.id}: ${activeThreads.size} active thread(s)`);

  for (const thread of activeThreads.values()) {
    try {
      const msgs = await readMessagesFrom(thread as AnyThreadChannel, cutoff);
      results.push(...msgs);
    } catch (err) {
      logger.warn(`[messageCollector] Failed to read active thread ${thread.id}:`, err);
    }
  }

  // 2. Recently archived threads — fetch up to 100, filter to those
  //    whose archiveTimestamp falls within the last 24h
  try {
    const { threads: archivedThreads } = await forum.threads.fetchArchived({ limit: 100 });
    const recentArchived = archivedThreads.filter(
      t => (t.archiveTimestamp ?? 0) >= cutoff,
    );
    logger.debug(`[messageCollector] Forum ${forum.id}: ${recentArchived.size} recently archived thread(s)`);

    for (const thread of recentArchived.values()) {
      try {
        const msgs = await readMessagesFrom(thread as AnyThreadChannel, cutoff);
        results.push(...msgs);
      } catch (err) {
        logger.warn(`[messageCollector] Failed to read archived thread ${thread.id}:`, err);
      }
    }
  } catch (err) {
    logger.warn(`[messageCollector] Failed to fetch archived threads for forum ${forum.id}:`, err);
  }

  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Collect all non-bot messages posted in the last 24 hours across the given
 * channel IDs. Automatically handles both text channels and forum channels.
 * Channels that are inaccessible are silently skipped.
 */
export async function collectRecentMessages(channelIds: string[]): Promise<string[]> {
  const client = getDiscordClient();
  const cutoff = Date.now() - WINDOW_MS;
  const all: string[] = [];

  for (const channelId of channelIds) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel) {
        logger.warn(`[messageCollector] Channel ${channelId} not found — skipping`);
        continue;
      }

      let msgs: string[] = [];

      if (channel.type === ChannelType.GuildForum) {
        // Forum channel — collect from all threads
        msgs = await readForumChannel(channel as GuildForumChannel, cutoff);
        logger.debug(`[messageCollector] Forum ${channelId}: ${msgs.length} messages total (last 24h)`);
      } else if (channel.isTextBased()) {
        // Regular text channel
        msgs = await readMessagesFrom(channel as TextChannel, cutoff);
        logger.debug(`[messageCollector] Channel ${channelId}: ${msgs.length} messages (last 24h)`);
      } else {
        logger.warn(`[messageCollector] Channel ${channelId} is not a text or forum channel — skipping`);
        continue;
      }

      all.push(...msgs);
    } catch (err) {
      logger.warn(`[messageCollector] Failed to process channel ${channelId}:`, err);
    }
  }

  logger.info(`[messageCollector] Total: ${all.length} messages across ${channelIds.length} channel(s) in the last 24h`);
  return all;
}
