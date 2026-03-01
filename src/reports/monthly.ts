/**
 * Monthly Report Builder
 * Aggregates the full previous calendar month, computes channel movers,
 * keyword themes, and staff comms summary, then posts a draft for approval.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { collectMetrics, lastMonthWindow } from '../collectors/metrics';
import { getKeywordBuckets } from '../collectors/keywords';
import {
  getDb,
  getPlayerRoleSnapshotsBetween,
  getChannelStatsForSnapshot,
  getSnapshotsBetween,
} from '../store/db';
import { postMonthlyDraft } from '../api/discord';
import {
  formatNumber,
  formatMonthYear,
  formatDate,
  formatPct,
  computeDelta,
  topN,
} from './formatters';
import { config } from '../config';
import { logger } from '../logger';

export async function runMonthlyReport(): Promise<void> {
  const [from, to] = lastMonthWindow();
  const monthLabel  = formatMonthYear(from);

  logger.info(`[monthly] Building report for ${monthLabel}`);

  // ── Collect current month's totals ─────────────────────────────────────────
  const current = await collectMetrics(from, to, 'monthly');

  // ── Find previous month snapshot for deltas ────────────────────────────────
  const prevFrom = new Date(from);
  prevFrom.setUTCMonth(prevFrom.getUTCMonth() - 1);
  const prevTo = new Date(from.getTime() - 1);

  const db = getDb();
  const prevRow = db
    .prepare(`SELECT * FROM snapshots WHERE period = 'monthly' AND id < ? ORDER BY taken_at DESC LIMIT 1`)
    .get(current.snapshotId) as any;

  // ── Section A: Month totals & deltas ──────────────────────────────────────
  const msgDelta    = computeDelta(current.messages,        prevRow?.messages,        false);
  const activeDelta = computeDelta(current.activeMembers,   prevRow?.active_members,  false);
  const joinDelta   = computeDelta(current.joins,           prevRow?.joins,           false);
  const leaveDelta  = computeDelta(current.leaves,          prevRow?.leaves,          true);
  const netChange   = (current.joins ?? 0) - (current.leaves ?? 0);
  const netSign     = netChange >= 0 ? '+' : '';

  // Daily average
  const daysInMonth = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  const dailyAvg    = current.messages != null ? Math.round(current.messages / daysInMonth) : null;

  // @Player role growth for the month
  const fromDate = from.toISOString().slice(0, 10);
  const toDate   = to.toISOString().slice(0, 10);
  const roleSnaps = getPlayerRoleSnapshotsBetween(fromDate, toDate);
  const roleStart = roleSnaps[0]?.total_count ?? null;
  const roleEnd   = roleSnaps[roleSnaps.length - 1]?.total_count ?? null;
  const roleDelta = computeDelta(roleEnd, roleStart, false);

  // ── Section B: Channel movers ──────────────────────────────────────────────
  const currentChannels = getChannelStatsForSnapshot(current.snapshotId);
  const prevChannels    = prevRow ? getChannelStatsForSnapshot(prevRow.id) : [];
  const channelMoversText = buildChannelMovers(currentChannels, prevChannels);

  // ── Section C: Keyword themes ──────────────────────────────────────────────
  const buckets = await getKeywordBuckets(from, to);
  const keywordText = buckets
    ? buckets.slice(0, 5)
        .map(b => `**${b.bucket}**: ${formatNumber(b.count)} mentions`)
        .join('\n') || '_No keyword data_'
    : '_Keyword data unavailable_';

  // ── Section D: Staff comms summary ────────────────────────────────────────
  // If staff role IDs are set, we'd normally filter Statbot per-member data here.
  // Placeholder — extend with actual per-member API call when available.
  const staffCommsText = config.discordStaffRoleIds.length
    ? '_Staff comms data requires per-member Statbot endpoint — configure DISCORD_STAFF_ROLE_IDS._'
    : '_Staff role IDs not configured — set DISCORD_STAFF_ROLE_IDS in .env_';

  // ── Build embed ────────────────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setTitle(`📅 Monthly Report — ${monthLabel}`)
    .setColor(0x1A7F37)
    .setDescription(`Full community stats for **${monthLabel}** (${formatDate(from)} – ${formatDate(to)})`)
    .addFields(
      // Section A
      {
        name:   '📊 Section A — Month Totals',
        value:  [
          `📨 **Messages**: ${formatNumber(current.messages)} (avg ${formatNumber(dailyAvg)}/day)\n  ${msgDelta.text}`,
          `👥 **Active Members**: ${formatNumber(current.activeMembers)}\n  ${activeDelta.text}`,
          `📥 **Joins**: ${formatNumber(current.joins)}  ${joinDelta.text}`,
          `📤 **Leaves**: ${formatNumber(current.leaves)}  ${leaveDelta.text}`,
          `⚖️ **Net Member Change**: ${netSign}${formatNumber(netChange)}`,
          `⚓ **@Player Role**: ${formatNumber(roleEnd)} (${roleDelta.text} this month)`,
        ].join('\n'),
        inline: false,
      },
      // Section B
      {
        name:   '📈 Section B — Channel Movers',
        value:  channelMoversText || '_No channel comparison data available_',
        inline: false,
      },
      // Section C
      {
        name:   '🔑 Section C — Keyword Themes',
        value:  keywordText,
        inline: false,
      },
      // Section D
      {
        name:   '🎖️ Section D — Staff Comms',
        value:  staffCommsText,
        inline: false,
      },
    )
    .setFooter({ text: `WoWS Community Reports · ${monthLabel} · Auto-generated` })
    .setTimestamp();

  // ── Delivery ──────────────────────────────────────────────────────────────
  if (config.monthlyDelivery === 'discord' || config.monthlyDelivery === 'both') {
    if (config.monthlyApprovalMode) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('approve_monthly')
          .setLabel('✅ Approve & Publish')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('request_edit')
          .setLabel('✏️ Request Edit')
          .setStyle(ButtonStyle.Secondary),
      );
      await postMonthlyDraft(embed, row);
    } else {
      // Publish immediately without approval
      const { postDailyReport } = await import('../api/discord');
      await postDailyReport(embed);
    }
  }

  logger.info(`[monthly] Report for ${monthLabel} complete`);
}

// ── Channel movers helper ──────────────────────────────────────────────────────

function buildChannelMovers(
  current: Array<{ channel_id: string; channel_name: string; messages: number }>,
  previous: Array<{ channel_id: string; channel_name: string; messages: number }>,
): string {
  if (!current.length) return '_No channel data_';

  const prevMap = new Map(previous.map(ch => [ch.channel_id, ch.messages]));

  const withDelta = current.map(ch => {
    const prev  = prevMap.get(ch.channel_id) ?? 0;
    const delta = ch.messages - prev;
    const pct   = prev !== 0 ? (delta / prev) * 100 : 0;
    return { ...ch, delta, pct };
  }).filter(ch => ch.delta !== 0);

  const growers  = [...withDelta].sort((a, b) => b.delta - a.delta).slice(0, 3);
  const decliners = [...withDelta].sort((a, b) => a.delta - b.delta).slice(0, 3);

  const fmt = (ch: typeof growers[0]) =>
    `#${ch.channel_name}: ${formatNumber(ch.messages)} (${ch.delta >= 0 ? '+' : ''}${formatNumber(ch.delta)}, ${formatPct(ch.pct)})`;

  const lines: string[] = [];
  if (growers.length)  lines.push('**📈 Top Growers**\n' + growers.map(fmt).join('\n'));
  if (decliners.length) lines.push('**📉 Top Decliners**\n' + decliners.map(fmt).join('\n'));
  return lines.join('\n\n');
}
