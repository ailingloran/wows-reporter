/**
 * Bug Report Tracker
 *
 * Listens to Discord's threadCreate event for new posts in configured forum
 * channels and provides two independently toggleable layers:
 *
 *   1. Auto-message (bug_auto_message_enabled)
 *      Posts the instructions embed in every new thread. No tags, no DB.
 *      Minimum config: bug_forum_channel_ids.
 *
 *   2. Full tracker (bug_tracker_enabled)
 *      Applies NEW BUG forum tag, adds a "Claim Bug" button to the message,
 *      records the report in bug_reports, and sends a notification. Requires
 *      bug_cm_group_id and the tag names to be pre-created on the forum channel.
 *
 * Reminder checks run on a daily cron (scheduler.ts) and ping the claiming CM
 * in the staff notification channel when there has been no follow-up activity.
 *
 * Discord permissions required:
 *   SEND_MESSAGES_IN_THREADS — always (for the auto-message)
 *   MANAGE_THREADS           — only when bug_tracker_enabled = true (tag edits)
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  ForumChannel,
  PublicThreadChannel,
  TextChannel,
} from 'discord.js';
import { getDiscordClient } from './api/discord';
import { getSetting } from './store/settingsDb';
import { getTrackedRoleMap, getTrackedUserMap } from './store/staffDb';
import {
  claimBugReport,
  deleteBugReport,
  getBugReport,
  getBugReports,
  getCmTagMap,
  getStaleClaimedBugs,
  isThreadTracked,
  recordReminder,
  setBotMessageId,
  upsertBugReport,
} from './store/bugDb';
import { logger } from './logger';

// ── In-memory config cache ────────────────────────────────────────────────────
// Refreshed from settingsDb by refreshBugConfig() — called on threadCreate and
// via the dashboard settings POST so changes take effect without restart.

let bugForumChannelIds = new Set<string>();

export function refreshBugConfig(): void {
  const raw = getSetting('bug_forum_channel_ids', '');
  bugForumChannelIds = new Set(
    raw.split(',').map(s => s.trim()).filter(Boolean),
  );
}

// ── Forum tag ID resolution ───────────────────────────────────────────────────
// Tags are looked up by name from channel.availableTags at runtime.
// Results cached per channel for 10 minutes to avoid redundant fetches.

const tagCache = new Map<string, { tagMap: Map<string, string>; expiry: number }>();
const TAG_CACHE_TTL_MS = 10 * 60_000;

async function resolveTagId(
  forum:   ForumChannel,
  tagName: string,
): Promise<string | undefined> {
  const now = Date.now();
  let entry = tagCache.get(forum.id);
  if (!entry || now > entry.expiry) {
    // Refresh: build name → id map from the channel's availableTags
    const freshForum = await forum.fetch() as ForumChannel;
    const tagMap = new Map<string, string>();
    for (const t of freshForum.availableTags) {
      tagMap.set(t.name.toLowerCase(), t.id);
    }
    entry = { tagMap, expiry: now + TAG_CACHE_TTL_MS };
    tagCache.set(forum.id, entry);
  }

  const id = entry.tagMap.get(tagName.toLowerCase());
  if (!id) {
    logger.warn(
      `[bugTracker] Tag "${tagName}" not found on forum channel #${forum.name} (${forum.id}). ` +
      `Create it manually on Discord then wait up to 10 min for the cache to refresh.`,
    );
  }
  return id;
}

// ── Handle a new bug thread ───────────────────────────────────────────────────

async function handleNewBugThread(thread: PublicThreadChannel): Promise<void> {
  const autoMsgOn  = getSetting('bug_auto_message_enabled', 'false') === 'true';
  const trackingOn = getSetting('bug_tracker_enabled',      'false') === 'true';

  // Idempotency guard — only relevant when tracking is on
  if (trackingOn && isThreadTracked(thread.id)) return;

  const client = getDiscordClient();
  let forum: ForumChannel | null = null;

  try {
    const ch = await client.channels.fetch(thread.parentId ?? '');
    if (ch?.type !== 15 /* ChannelType.GuildForum */) return; // not a forum channel
    forum = ch as ForumChannel;
  } catch (err) {
    logger.warn(`[bugTracker] Could not fetch forum channel for thread ${thread.id}:`, err);
  }

  // ── Auto-message layer ──────────────────────────────────────────────────────
  if (autoMsgOn) {
    const instructionsText = getSetting('bug_instructions_text', '');
    const embed = new EmbedBuilder()
      .setTitle('📋 How to Report a Bug')
      .setDescription(instructionsText || '_Instructions not configured. Set bug_instructions_text in dashboard settings._')
      .setColor(0x2E6DB4)
      .setFooter({ text: 'WoWS Bug Reports · Please follow these guidelines' });

    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    if (trackingOn) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`bug_claim:${thread.id}`)
            .setLabel('🐛 Claim Bug')
            .setStyle(ButtonStyle.Primary),
        ),
      );
    }

    try {
      const msg = await thread.send({ embeds: [embed], components });
      if (trackingOn) {
        // Store bot_message_id so we can edit it when the report is claimed
        setBotMessageId(thread.id, msg.id);
      }
      logger.info(`[bugTracker] Auto-message posted in thread "${thread.name}" (${thread.id})`);
    } catch (err) {
      logger.error(`[bugTracker] Failed to post auto-message in thread ${thread.id}:`, err);
    }
  }

  // ── Full tracking layer ─────────────────────────────────────────────────────
  if (!trackingOn) return;

  // Record in DB (bot_message_id set above via setBotMessageId if autoMsgOn)
  upsertBugReport({
    thread_id:        thread.id,
    forum_channel_id: thread.parentId ?? '',
    title:            thread.name,
    status:           'new',
    claimed_by_id:    null,
    claimed_by_name:  null,
    claimed_at:       null,
    bot_message_id:   null,   // updated above if auto-message was posted
    created_at:       thread.createdTimestamp ?? Date.now(),
    last_reminder_at: null,
  });

  // Apply NEW BUG tag
  if (forum) {
    const newTagId = await resolveTagId(forum, getSetting('bug_new_tag_name', 'NEW BUG'));
    if (newTagId) {
      try {
        const existingTagIds = thread.appliedTags ?? [];
        if (!existingTagIds.includes(newTagId)) {
          await thread.setAppliedTags([...existingTagIds, newTagId]);
          logger.info(`[bugTracker] Applied NEW BUG tag to thread ${thread.id}`);
        }
      } catch (err) {
        logger.error(
          `[bugTracker] Failed to apply NEW BUG tag to thread ${thread.id} ` +
          `— check that the bot has MANAGE_THREADS permission:`, err,
        );
      }
    }
  }

  // Notification in staff channel
  const notifChannelId = getSetting('bug_notification_channel_id', '');
  if (notifChannelId) {
    try {
      const notifCh = await client.channels.fetch(notifChannelId);
      if (notifCh?.isTextBased()) {
        await (notifCh as TextChannel).send({
          embeds: [
            new EmbedBuilder()
              .setTitle('🐛 New Bug Report')
              .setDescription(`**[${thread.name}](https://discord.com/channels/${getSetting('bug_guild_id', '')}/${thread.id})**`)
              .setColor(0xE67E22)
              .setTimestamp(),
          ],
        });
      }
    } catch (err) {
      logger.warn(`[bugTracker] Could not post to notification channel ${notifChannelId}:`, err);
    }
  }

  logger.info(`[bugTracker] Bug report tracked: "${thread.name}" (${thread.id})`);
}

// ── Claim button handler ──────────────────────────────────────────────────────

export async function handleBugButton(interaction: ButtonInteraction): Promise<void> {
  // customId format: "bug_claim:{threadId}"
  const threadId = interaction.customId.split(':').slice(1).join(':');

  const report = getBugReport(threadId);
  if (!report) {
    await interaction.reply({ content: '❌ Bug report not found in tracker.', ephemeral: true });
    return;
  }

  if (report.claimed_by_id) {
    await interaction.reply({
      content: `⚠️ Already claimed by **${report.claimed_by_name}**.`,
      ephemeral: true,
    });
    return;
  }

  // Verify the clicker is in the configured CM group
  const cmGroupId = parseInt(getSetting('bug_cm_group_id', ''), 10);
  if (!cmGroupId) {
    await interaction.reply({
      content: '❌ Bug tracker not configured (no CM group set). Contact an admin.',
      ephemeral: true,
    });
    return;
  }

  const userId = interaction.user.id;
  const userMap = getTrackedUserMap();
  const roleMap = getTrackedRoleMap();

  const memberRoles = interaction.member && 'roles' in interaction.member && interaction.member.roles
    ? 'cache' in (interaction.member.roles as any)
      ? [...(interaction.member.roles as any).cache.keys()] as string[]
      : interaction.member.roles as string[]
    : [];

  const isDirectCm = userMap.get(userId) === cmGroupId;
  const isRoleCm   = memberRoles.some(rid => roleMap.get(rid) === cmGroupId);

  if (!isDirectCm && !isRoleCm) {
    await interaction.reply({
      content: '❌ Only Community Managers can claim bug reports.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const displayName = interaction.member && 'displayName' in interaction.member
    ? (interaction.member as any).displayName as string
    : interaction.user.username;

  // Update DB
  claimBugReport(threadId, userId, displayName);

  // Swap tags: remove NEW BUG, apply CLAIMED
  const client = getDiscordClient();
  try {
    const thread = await client.channels.fetch(threadId) as PublicThreadChannel;
    const forumCh = thread.parentId
      ? await client.channels.fetch(thread.parentId) as ForumChannel
      : null;

    if (forumCh) {
      const newTagName     = getSetting('bug_new_tag_name',    'NEW BUG');
      const claimedTagName = getSetting('bug_claimed_tag_name', 'CLAIMED');
      const [newTagId, claimedTagId] = await Promise.all([
        resolveTagId(forumCh, newTagName),
        resolveTagId(forumCh, claimedTagName),
      ]);

      const currentTags = thread.appliedTags ?? [];

      // Look up a personal tag for this CM (may be undefined — not all CMs have one)
      const cmTagName = getCmTagMap().get(userId);
      const cmTagId   = cmTagName ? await resolveTagId(forumCh, cmTagName) : undefined;

      const updatedTags = [
        ...currentTags.filter(id => id !== newTagId),                                         // remove NEW BUG
        ...(claimedTagId && !currentTags.includes(claimedTagId) ? [claimedTagId] : []),        // always add CLAIMED
        ...(cmTagId      && !currentTags.includes(cmTagId)      ? [cmTagId]      : []),        // add CM personal tag if mapped
      ];
      await thread.setAppliedTags(updatedTags);
    }

    // Edit the bot's auto-message to reflect claimed status
    if (report.bot_message_id) {
      try {
        const botMsg = await thread.messages.fetch(report.bot_message_id);
        const claimedAt = new Date().toLocaleString('en-GB', { timeZone: 'Europe/Berlin' });
        const updatedEmbed = EmbedBuilder.from(botMsg.embeds[0])
          .setFooter({ text: `Claimed by ${displayName} · ${claimedAt} CET` })
          .setColor(0x2ECC71);
        await botMsg.edit({ embeds: [updatedEmbed], components: [] });
      } catch (err) {
        logger.warn(`[bugTracker] Could not edit auto-message for thread ${threadId}:`, err);
      }
    }
  } catch (err) {
    logger.error(`[bugTracker] Error during claim tag-swap for thread ${threadId}:`, err);
  }

  // Notify staff channel
  const notifChannelId = getSetting('bug_notification_channel_id', '');
  if (notifChannelId) {
    try {
      const notifCh = await client.channels.fetch(notifChannelId);
      if (notifCh?.isTextBased()) {
        const guildId = getSetting('bug_guild_id', '');
        await (notifCh as TextChannel).send({
          embeds: [
            new EmbedBuilder()
              .setTitle('✅ Bug Report Claimed')
              .setDescription(
                `<@${userId}> claimed **[${report.title}](https://discord.com/channels/${guildId}/${threadId})**`,
              )
              .setColor(0x2ECC71)
              .setTimestamp(),
          ],
        });
      }
    } catch (err) {
      logger.warn(`[bugTracker] Could not post claim notification:`, err);
    }
  }

  await interaction.editReply({ content: `✅ Bug report claimed. Good luck, ${displayName}!` });
  logger.info(`[bugTracker] "${report.title}" (${threadId}) claimed by ${displayName} (${userId})`);
}

// ── Reminder check (called by daily cron) ─────────────────────────────────────

export async function runBugReminders(): Promise<void> {
  const cmGroupIdStr      = getSetting('bug_cm_group_id',             '');
  const notifChannelId    = getSetting('bug_notification_channel_id', '');
  const reminderDaysStr   = getSetting('bug_reminder_days',           '2');

  if (!cmGroupIdStr || !notifChannelId) {
    logger.info('[bugTracker] Reminder check skipped — CM group or notification channel not configured');
    return;
  }

  const cmGroupId   = parseInt(cmGroupIdStr, 10);
  const reminderMs  = parseInt(reminderDaysStr, 10) * 86_400_000;
  const cutoffMs    = Date.now() - reminderMs;
  const staleBugs   = getStaleClaimedBugs(cmGroupId, cutoffMs);

  if (staleBugs.length === 0) {
    logger.info('[bugTracker] Reminder check: no stale claimed bugs found');
    return;
  }

  logger.info(`[bugTracker] Reminder check: ${staleBugs.length} stale bug(s) found`);

  const client     = getDiscordClient();
  const guildId    = getSetting('bug_guild_id', '');

  let notifCh: TextChannel | null = null;
  try {
    const ch = await client.channels.fetch(notifChannelId);
    if (ch?.isTextBased()) notifCh = ch as TextChannel;
  } catch (err) {
    logger.error('[bugTracker] Could not fetch notification channel for reminders:', err);
    return;
  }

  for (const bug of staleBugs) {
    const daysSinceClaim = bug.claimed_at
      ? Math.floor((Date.now() - bug.claimed_at) / 86_400_000)
      : '?';
    const threadLink = `https://discord.com/channels/${guildId}/${bug.thread_id}`;

    try {
      await notifCh!.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('⏰ Bug Report Follow-up Reminder')
            .setDescription(
              `<@${bug.claimed_by_id}>, please follow up on ` +
              `**[${bug.title}](${threadLink})**\n` +
              `Claimed ${daysSinceClaim} day(s) ago with no activity in the thread.`,
            )
            .setColor(0xE74C3C)
            .setFooter({ text: `Reminder #${bug.reminder_count + 1}` })
            .setTimestamp(),
        ],
      });
      recordReminder(bug.thread_id);
      logger.info(`[bugTracker] Reminder sent for "${bug.title}" (${bug.thread_id})`);
    } catch (err) {
      logger.error(`[bugTracker] Failed to send reminder for ${bug.thread_id}:`, err);
    }
  }
}

// ── Startup scan ──────────────────────────────────────────────────────────────
// On bot start, fetch active threads from all configured forum channels and
// process any that are not yet in bug_reports. Handles threads created while
// the bot was offline.

async function runStartupScan(): Promise<void> {
  if (getSetting('bug_startup_scan_enabled', 'true') !== 'true') return;
  if (bugForumChannelIds.size === 0) return;

  const client = getDiscordClient();
  logger.info(`[bugTracker] Startup scan: checking ${bugForumChannelIds.size} forum channel(s)…`);
  let scanned = 0;
  let found   = 0;

  for (const channelId of bugForumChannelIds) {
    try {
      const forum = await client.channels.fetch(channelId) as ForumChannel;
      const { threads } = await forum.threads.fetchActive();
      scanned += threads.size;
      for (const [, thread] of threads) {
        if (!isThreadTracked(thread.id)) {
          found++;
          await handleNewBugThread(thread as PublicThreadChannel).catch(err =>
            logger.error(`[bugTracker] Startup scan failed for thread ${thread.id}:`, err),
          );
        }
      }
    } catch (err) {
      logger.error(`[bugTracker] Startup scan failed for channel ${channelId}:`, err);
    }
  }

  logger.info(`[bugTracker] Startup scan complete — ${scanned} thread(s) checked, ${found} new`);
}

// ── Dashboard helpers (exported for server.ts) ────────────────────────────────

export { getBugReports, deleteBugReport };
export { runStartupScan };

// ── Entry point ───────────────────────────────────────────────────────────────

export function startBugTracker(): void {
  refreshBugConfig();

  const client = getDiscordClient();

  client.on('threadCreate', async (thread, newlyCreated) => {
    if (!newlyCreated) return;

    // Re-read config on each event (infrequent) so settings changes take effect
    refreshBugConfig();

    const autoMsgOn  = getSetting('bug_auto_message_enabled', 'false') === 'true';
    const trackingOn = getSetting('bug_tracker_enabled',      'false') === 'true';
    if (!autoMsgOn && !trackingOn) return;
    if (!bugForumChannelIds.has(thread.parentId ?? '')) return;

    // Fetch the full thread object — Discord may not populate all fields immediately
    const fullThread = await (thread as PublicThreadChannel).fetch().catch(() => thread);
    await handleNewBugThread(fullThread as PublicThreadChannel).catch(err =>
      logger.error('[bugTracker] threadCreate handler error:', err),
    );
  });

  // Run startup scan after a short delay to ensure Discord client is fully ready
  setTimeout(() => {
    runStartupScan().catch(err =>
      logger.error('[bugTracker] Startup scan error:', err),
    );
  }, 5_000);

  logger.info('[bugTracker] Bug tracker started');
}
