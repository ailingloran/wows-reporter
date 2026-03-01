/**
 * Daily Report Builder
 * Collects metrics for yesterday, computes deltas vs the previous day,
 * and posts a formatted Discord embed to the staff channel.
 */

import { EmbedBuilder } from 'discord.js';
import { collectMetrics, yesterdayWindow } from '../collectors/metrics';
import { getLastSnapshot, getChannelStatsForSnapshot } from '../store/db';
import { postDailyReport } from '../api/discord';
import {
  formatNumber,
  formatDate,
  computeDelta,
  buildHotspotText,
} from './formatters';
import { config } from '../config';
import { logger } from '../logger';

export async function runDailyReport(): Promise<void> {
  const [from, to] = yesterdayWindow();

  // Collect & store today's snapshot
  const current = await collectMetrics(from, to, 'daily');

  // Find the previous daily snapshot for delta calculation
  const prevRow = getLastSnapshot('daily');
  // Note: getLastSnapshot returns the most recent — which is now the one we just inserted.
  // We need the one before that. Handled by getting the previous by ordering:
  const db = (await import('../store/db')).getDb();
  const previousRow = db
    .prepare(`SELECT * FROM snapshots WHERE period = 'daily' AND id < ? ORDER BY taken_at DESC LIMIT 1`)
    .get(current.snapshotId) as any;

  const prev = previousRow ?? null;

  // Build deltas
  const msgDelta    = computeDelta(current.messages,      prev?.messages,      false);
  const activeDelta = computeDelta(current.activeMembers, prev?.active_members, false);
  const joinDelta   = computeDelta(current.joins,         prev?.joins,         false);
  const leaveDelta  = computeDelta(current.leaves,        prev?.leaves,        true);
  const roleDelta   = computeDelta(current.playerRoleCount, prev?.player_role_count, false);

  const netChange   = (current.joins ?? 0) - (current.leaves ?? 0);
  const netSign     = netChange >= 0 ? '+' : '';

  // Channel hotspots
  const channelRows = getChannelStatsForSnapshot(current.snapshotId);
  const hotspotText = buildHotspotText(channelRows, current.messages);

  // Build embed
  const embed = new EmbedBuilder()
    .setTitle(`📊 Daily Report — ${formatDate(from)}`)
    .setColor(0x2E6DB4)
    .setDescription(`Community stats for **${formatDate(from)}**`)
    .addFields(
      {
        name:   '📨 Messages',
        value:  `**${formatNumber(current.messages)}**\n${msgDelta.text}`,
        inline: true,
      },
      {
        name:   '👥 Active Members',
        value:  `**${formatNumber(current.activeMembers)}**\n${activeDelta.text}`,
        inline: true,
      },
      {
        name:   '\u200b',
        value:  '\u200b',
        inline: true,
      },
      {
        name:   '📥 Joins',
        value:  `**${formatNumber(current.joins)}**\n${joinDelta.text}`,
        inline: true,
      },
      {
        name:   '📤 Leaves',
        value:  `**${formatNumber(current.leaves)}**\n${leaveDelta.text}`,
        inline: true,
      },
      {
        name:   '⚖️ Net Change',
        value:  `**${netSign}${formatNumber(netChange)}**`,
        inline: true,
      },
      {
        name:   '⚓ @Player Role',
        value:  `**${formatNumber(current.playerRoleCount)}** total\n${roleDelta.text}`,
        inline: true,
      },
      {
        name:   '\u200b',
        value:  '\u200b',
        inline: true,
      },
      {
        name:   '\u200b',
        value:  '\u200b',
        inline: true,
      },
      {
        name:   '🔥 Top Channels Today',
        value:  hotspotText,
        inline: false,
      },
    )
    .setFooter({ text: 'WoWS Community Reports · Auto-generated' })
    .setTimestamp();

  // Deliver
  if (config.dailyDelivery === 'discord' || config.dailyDelivery === 'both') {
    await postDailyReport(embed);
  }
  if (config.dailyDelivery === 'dashboard' || config.dailyDelivery === 'both') {
    logger.info('[daily] Dashboard delivery: data saved to DB for dashboard display');
  }
}
