/**
 * Forum Response Monitor
 *
 * Periodically checks configured forum channels for threads that have been
 * open longer than forum_monitor_threshold_hours with no message from a member
 * holding the configured CM role ID.
 *
 * Schedule (registered in scheduler.ts):
 *   Runs hourly Mon–Fri at Europe/Berlin (= Prague) time.
 *   Skips Sat/Sun entirely — Monday's 08:00 run naturally picks up any
 *   weekend threads that went unanswered.
 *
 * Notifications are embeds (no pings).
 * Once a thread is notified, or a CM response is found, it is marked done
 * in forum_monitor_done and never checked again.
 */

import {
  EmbedBuilder,
  ForumChannel,
  PublicThreadChannel,
  TextChannel,
} from 'discord.js';
import { getDiscordClient } from './api/discord';
import { getSetting } from './store/settingsDb';
import { isForumThreadDone, markForumThreadDone } from './store/forumMonitorDb';
import { logger } from './logger';

// ── In-memory config cache ────────────────────────────────────────────────────

let monitorChannelIds = new Set<string>();

export function refreshForumMonitorConfig(): void {
  const raw = getSetting('forum_monitor_channel_ids', '');
  monitorChannelIds = new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

// ── CM response check ─────────────────────────────────────────────────────────

async function hasCmResponse(thread: PublicThreadChannel, cmRoleId: string): Promise<boolean> {
  try {
    const messages = await thread.messages.fetch({ limit: 100 });
    for (const [, msg] of messages) {
      if (msg.author.bot) continue;
      const member = await thread.guild.members.fetch(msg.author.id).catch(() => null);
      if (member?.roles.cache.has(cmRoleId)) return true;
    }
  } catch (err) {
    logger.warn(`[forumMonitor] Could not check messages for thread ${thread.id}:`, err);
  }
  return false;
}

// ── Main check ────────────────────────────────────────────────────────────────

export async function runForumMonitorCheck(): Promise<void> {
  if (getSetting('forum_monitor_enabled', 'false') !== 'true') return;

  const cmRoleId       = getSetting('forum_monitor_cm_role_id',       '');
  const notifChannelId = getSetting('forum_monitor_notif_channel_id', '');
  const thresholdHours = parseInt(getSetting('forum_monitor_threshold_hours', '5'), 10);

  if (!monitorChannelIds.size || !cmRoleId || !notifChannelId) {
    logger.info('[forumMonitor] Check skipped — not fully configured');
    return;
  }

  const thresholdMs = thresholdHours * 3_600_000;
  const cutoffMs    = Date.now() - thresholdMs;
  const client      = getDiscordClient();

  type UnansweredThread = { name: string; threadId: string; guildId: string; ageHours: number };
  const unanswered: UnansweredThread[] = [];

  for (const channelId of monitorChannelIds) {
    try {
      const forum = await client.channels.fetch(channelId) as ForumChannel;
      const { threads } = await forum.threads.fetchActive();

      for (const [, thread] of threads) {
        if (isForumThreadDone(thread.id)) continue;

        const createdAt = thread.createdTimestamp ?? 0;
        if (createdAt > cutoffMs) continue; // not old enough yet

        const ageHours = Math.floor((Date.now() - createdAt) / 3_600_000);

        const responded = await hasCmResponse(thread as PublicThreadChannel, cmRoleId);
        if (responded) {
          markForumThreadDone(thread.id); // CM already engaged — stop checking
          continue;
        }

        unanswered.push({ name: thread.name, threadId: thread.id, guildId: thread.guildId, ageHours });
      }
    } catch (err) {
      logger.error(`[forumMonitor] Error checking channel ${channelId}:`, err);
    }
  }

  if (unanswered.length === 0) {
    logger.info('[forumMonitor] Check complete — no unanswered threads');
    return;
  }

  logger.info(`[forumMonitor] ${unanswered.length} unanswered thread(s) found`);

  try {
    const notifCh = await client.channels.fetch(notifChannelId);
    if (!notifCh?.isTextBased()) return;

    const lines = unanswered.map(t =>
      `• **[${t.name}](https://discord.com/channels/${t.guildId}/${t.threadId})** — ${t.ageHours}h without CM response`,
    );

    // Split into chunks to stay within Discord's 4096-char embed description limit
    const chunks: string[][] = [[]];
    let currentLen = 0;
    for (const line of lines) {
      if (currentLen + line.length > 3_800) {
        chunks.push([]);
        currentLen = 0;
      }
      chunks[chunks.length - 1].push(line);
      currentLen += line.length + 1;
    }

    for (let i = 0; i < chunks.length; i++) {
      await (notifCh as TextChannel).send({
        embeds: [
          new EmbedBuilder()
            .setTitle(i === 0
              ? `⏳ ${unanswered.length} thread${unanswered.length === 1 ? '' : 's'} awaiting CM response`
              : '(continued)')
            .setDescription(chunks[i].join('\n'))
            .setColor(0xE67E22)
            .setTimestamp(),
        ],
      });
    }

    // Mark all as done only after a successful notification
    for (const t of unanswered) markForumThreadDone(t.threadId);
    logger.info(`[forumMonitor] Notification sent, ${unanswered.length} thread(s) marked done`);

  } catch (err) {
    logger.error('[forumMonitor] Failed to post notification:', err);
    // Don't mark as done — will retry next check
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function startForumMonitor(): void {
  refreshForumMonitorConfig();
  logger.info('[forumMonitor] Forum response monitor started');
}
