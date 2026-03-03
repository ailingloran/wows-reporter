/**
 * Slash command registration.
 * Registers guild-scoped commands via Discord REST so they appear instantly.
 */

import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { config } from '../config';
import { logger } from '../logger';
import { getDiscordClient } from '../api/discord';

const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('report')
    .setDescription('Manually trigger a report')
    .addSubcommand(sub =>
      sub.setName('daily').setDescription('Snapshot @Player role and post the daily report now'))
    .addSubcommand(sub =>
      sub.setName('monthly').setDescription('Post the monthly report now')),

  new SlashCommandBuilder()
    .setName('snapshot')
    .setDescription('Take a fresh @Player role count snapshot and show the result'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot status — last report times and current @Player role count'),

  new SlashCommandBuilder()
    .setName('sentiment')
    .setDescription('Community Pulse — AI sentiment analysis (admin only)')
    .addSubcommand(sub =>
      sub.setName('run').setDescription('Trigger the Community Pulse report now'))
    .addSubcommand(sub =>
      sub.setName('status').setDescription('Show when the last Community Pulse report ran')),
];

export async function registerCommands(): Promise<void> {
  const applicationId = getDiscordClient().user!.id;
  const rest = new REST().setToken(config.discordBotToken);

  try {
    await rest.put(
      Routes.applicationGuildCommands(applicationId, config.statbotGuildId),
      { body: commandDefinitions.map(cmd => cmd.toJSON()) },
    );
    logger.info('[commands] Slash commands registered for guild');
  } catch (err) {
    logger.error('[commands] Failed to register slash commands:', err);
    throw err;
  }
}
