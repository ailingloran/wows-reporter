/**
 * Slash command interaction handlers.
 * Each exported function handles one command (or subcommand).
 */

import { ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { config } from '../config';
import { logger } from '../logger';
import { runDailyReport } from '../reports/daily';
import { runMonthlyReport } from '../reports/monthly';
import { snapshotPlayerRole } from '../collectors/memberTracker';
import { getLastSnapshot, getLatestPlayerRoleSnapshot } from '../store/db';
import { getDiscordClient } from '../api/discord';
import { formatNumber } from '../reports/formatters';

// ── Permission check ──────────────────────────────────────────────────────────

function isStaff(interaction: ChatInputCommandInteraction): boolean {
  if (!interaction.inGuild() || !interaction.member) return false;

  if (config.discordStaffRoleIds.length === 0) {
    return interaction.memberPermissions?.has('Administrator') ?? false;
  }

  // interaction.member.roles is either Snowflake[] (APIInteractionGuildMember)
  // or a RoleManager (full GuildMember). Handle both.
  const roles = interaction.member.roles;
  const roleIds: string[] = Array.isArray(roles)
    ? roles
    : [...(interaction.member as GuildMember).roles.cache.keys()];

  return config.discordStaffRoleIds.some(id => roleIds.includes(id));
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function handleReportDaily(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: '❌ You don\'t have permission to use this command.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  logger.info(`[commands] /report daily triggered by ${interaction.user.tag}`);

  try {
    const client = getDiscordClient();
    const guild  = await client.guilds.fetch(config.statbotGuildId);
    await snapshotPlayerRole(guild);
    await runDailyReport();
    await interaction.editReply('✅ Daily report generated and posted.');
  } catch (err) {
    logger.error('[commands] /report daily failed:', err);
    await interaction.editReply('❌ Failed to generate daily report. Check the bot logs.');
  }
}

export async function handleReportMonthly(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: '❌ You don\'t have permission to use this command.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  logger.info(`[commands] /report monthly triggered by ${interaction.user.tag}`);

  try {
    await runMonthlyReport();
    await interaction.editReply('✅ Monthly report draft posted.');
  } catch (err) {
    logger.error('[commands] /report monthly failed:', err);
    await interaction.editReply('❌ Failed to generate monthly report. Check the bot logs.');
  }
}

export async function handleSnapshot(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: '❌ You don\'t have permission to use this command.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  logger.info(`[commands] /snapshot triggered by ${interaction.user.tag}`);

  try {
    const client = getDiscordClient();
    const guild  = await client.guilds.fetch(config.statbotGuildId);
    const count  = await snapshotPlayerRole(guild);
    await interaction.editReply(`✅ Snapshot saved: **${formatNumber(count)}** @Player members.`);
  } catch (err) {
    logger.error('[commands] /snapshot failed:', err);
    await interaction.editReply('❌ Failed to take snapshot. Check the bot logs.');
  }
}

export async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: '❌ You don\'t have permission to use this command.', ephemeral: true });
    return;
  }

  const lastDaily   = getLastSnapshot('daily');
  const lastMonthly = getLastSnapshot('monthly');
  const lastRole    = getLatestPlayerRoleSnapshot();

  const fmt = (isoStr: string) =>
    new Date(isoStr).toLocaleString('en-GB', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });

  const lines = [
    `⚓ **@Player Role**: ${lastRole ? `${formatNumber(lastRole.total_count)} *(snapshot: ${lastRole.snapshot_date})*` : 'No snapshot yet'}`,
    `📊 **Last Daily Report**: ${lastDaily ? fmt(lastDaily.taken_at) : 'Never'}`,
    `📅 **Last Monthly Report**: ${lastMonthly ? fmt(lastMonthly.taken_at) : 'Never'}`,
  ];

  await interaction.reply({ content: lines.join('\n'), ephemeral: true });
}
