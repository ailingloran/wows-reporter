/**
 * Discord bot client — initialisation, message delivery, and interaction handling.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ChatInputCommandInteraction,
  TextChannel,
  Guild,
  Collection,
  Message,
} from 'discord.js';
import { config } from '../config';
import { logger } from '../logger';

let discordClient: Client;

// Pending monthly draft messages awaiting approval: messageId → guild
const pendingApprovals = new Collection<string, Guild>();

export function getDiscordClient(): Client {
  if (!discordClient) throw new Error('Discord client not initialised. Call initDiscordClient() first.');
  return discordClient;
}

export async function initDiscordClient(): Promise<Client> {
  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,      // PRIVILEGED — required for @Player tracker
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,    // PRIVILEGED — required for keyword scanning
    ],
    partials: [Partials.GuildMember],
  });

  // Register the @Player role tracker listener
  discordClient.on('guildMemberUpdate', async (oldMember, newMember) => {
    const { handleMemberUpdate } = await import('../collectors/memberTracker');
    handleMemberUpdate(oldMember, newMember);
  });

  // Handle interactions (buttons + slash commands)
  discordClient.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) {
      await handleButtonInteraction(interaction as ButtonInteraction);
    } else if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction as ChatInputCommandInteraction);
    }
  });

  // Wait for the ready event so client.user is populated before returning
  const ready = new Promise<void>(resolve => {
    discordClient.once('ready', () => {
      logger.info(`Discord bot logged in as ${discordClient.user?.tag}`);
      resolve();
    });
  });

  await discordClient.login(config.discordBotToken);
  await ready;
  return discordClient;
}

// ── Publishing helpers ────────────────────────────────────────────────────────

/** Post the daily report embed to the staff channel. */
export async function postDailyReport(embed: EmbedBuilder): Promise<void> {
  const channel = await getTextChannel(config.discordStaffChannelId);
  await channel.send({ embeds: [embed] });
  logger.info('[discord] Daily report posted');
}

/** Post monthly report draft with approval buttons. */
export async function postMonthlyDraft(
  embed: EmbedBuilder,
  row: ActionRowBuilder<ButtonBuilder>,
): Promise<Message> {
  const channel = await getTextChannel(config.discordMonthlyChannelId);
  const msg = await channel.send({
    content: '📋 **Monthly Report Draft** — Please review and approve below.',
    embeds:  [embed],
    components: [row],
  });
  logger.info('[discord] Monthly draft posted, awaiting approval');
  return msg;
}

/** Publish the final monthly report (removes buttons, reposts as clean embed). */
export async function publishFinalMonthlyReport(embed: EmbedBuilder, draftMsg: Message): Promise<void> {
  // Edit the draft to remove buttons and mark as published
  await draftMsg.edit({
    content: '✅ **Monthly Report — Published**',
    embeds:  [embed],
    components: [],
  });
  logger.info('[discord] Monthly report published');
}

// ── Button Interaction Handler ────────────────────────────────────────────────

async function handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
  if (interaction.customId === 'approve_monthly') {
    await interaction.deferReply({ ephemeral: true });
    try {
      // Remove approval buttons from the draft message
      await interaction.message.edit({ components: [] });
      await interaction.editReply({ content: '✅ Monthly report published successfully!' });
      logger.info(`[discord] Monthly report approved by ${interaction.user.tag}`);
    } catch (err) {
      logger.error('[discord] Failed to publish monthly report:', err);
      await interaction.editReply({ content: '❌ Failed to publish. Check the bot logs.' });
    }
  }

  if (interaction.customId === 'request_edit') {
    await interaction.reply({
      content: '✏️ Edit requested. Please make your changes and re-run `--test-monthly` or wait for next scheduled run.',
      ephemeral: true,
    });
    logger.info(`[discord] Edit requested by ${interaction.user.tag}`);
  }
}

// ── Slash command router ──────────────────────────────────────────────────────

async function handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  // Dynamic import avoids a circular dependency with the handlers module
  const { handleReportDaily, handleReportMonthly, handleSnapshot, handleStatus } =
    await import('../commands/handlers');

  try {
    if (interaction.commandName === 'report') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'daily')   await handleReportDaily(interaction);
      if (sub === 'monthly') await handleReportMonthly(interaction);
    } else if (interaction.commandName === 'snapshot') {
      await handleSnapshot(interaction);
    } else if (interaction.commandName === 'status') {
      await handleStatus(interaction);
    }
  } catch (err) {
    logger.error('[discord] Unhandled slash command error:', err);
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function getTextChannel(channelId: string): Promise<TextChannel> {
  const channel = await discordClient.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`Channel ${channelId} not found or not a text channel`);
  }
  return channel as TextChannel;
}
