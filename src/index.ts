/**
 * WoWS Discord Reporting Pack Generator
 * Entry point — initialises DB, Discord client, cron scheduler, and optional dashboard.
 */

import 'dotenv/config';
import { initDb } from './store/db';
import { initMessageDb } from './store/messageDb';
import { initSettings } from './store/settingsDb';
import { initStaffGroups } from './store/staffDb';
import { initDiscordClient, getDiscordClient } from './api/discord';
import { registerSchedules } from './scheduler';
import { runDailyReport } from './reports/daily';
import { runMonthlyReport } from './reports/monthly';
import { startDashboard } from './dashboard/server';
import { startMessageIndexer, backfillMessages } from './indexer/messageIndexer';
import { startStaffTracker } from './staffTracker';
import { config } from './config';
import { logger } from './logger';

async function main() {
  logger.info('=== WoWS Reporter starting ===');

  // 1. Initialise SQLite databases
  initDb();
  initMessageDb();
  initSettings();
  initStaffGroups();
  logger.info('Databases initialised');

  // 2. Connect Discord bot
  await initDiscordClient();
  logger.info('Discord client ready');

  const args = process.argv.slice(2);

  // 3. Register slash commands (skip in one-shot CLI modes)
  if (!args.includes('--seed') && !args.includes('--test-daily') && !args.includes('--test-monthly')) {
    const { registerCommands } = await import('./commands/register');
    await registerCommands();
  }

  // ── Seed mode: take initial @Player role baseline snapshot ──────────────────
  if (args.includes('--seed')) {
    logger.info('Seed mode: taking @Player role baseline snapshot...');
    const { seedPlayerRoleBaseline } = await import('./collectors/memberTracker');
    const client = getDiscordClient();
    const guild = await client.guilds.fetch(config.statbotGuildId);
    await seedPlayerRoleBaseline(guild);
    logger.info('Baseline snapshot complete. Exiting seed mode.');
    process.exit(0);
  }

  // ── Manual test modes ────────────────────────────────────────────────────────
  if (args.includes('--test-daily')) {
    logger.info('Test mode: triggering daily report manually...');
    const { snapshotPlayerRole } = await import('./collectors/memberTracker');
    const guild = await getDiscordClient().guilds.fetch(config.statbotGuildId);
    await snapshotPlayerRole(guild);
    await runDailyReport();
    logger.info('Daily report test complete. Exiting.');
    process.exit(0);
  }

  if (args.includes('--test-monthly')) {
    logger.info('Test mode: triggering monthly report manually...');
    await runMonthlyReport();
    logger.info('Monthly report test complete. Exiting.');
    process.exit(0);
  }

  // ── Backfill mode ─────────────────────────────────────────────────────────────
  const backfillArg = args.find(a => a.startsWith('--backfill'));
  if (backfillArg !== undefined) {
    const hours = backfillArg.includes('=') ? parseInt(backfillArg.split('=')[1], 10) : 168;
    logger.info(`Backfill mode: fetching last ${hours}h of messages…`);
    await backfillMessages(hours);
    logger.info('Backfill complete. Exiting.');
    process.exit(0);
  }

  // ── Normal operation ─────────────────────────────────────────────────────────
  // 3. Register cron jobs
  registerSchedules();
  logger.info(`Cron jobs registered. Daily: "${config.dailyCron}", Monthly: "${config.monthlyCron}" (Europe/Berlin)`);

  // 4. Start web dashboard (always — needed for settings API)
  startDashboard();
  logger.info(`Dashboard listening on port ${config.dashboardPort}`);

  // 5. Start real-time message indexer
  startMessageIndexer();

  // 6. Start staff activity tracker (full-server coverage)
  startStaffTracker();

  logger.info('=== WoWS Reporter running. Waiting for scheduled events. ===');
}

main().catch((err) => {
  logger.error('Fatal error during startup:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT',  () => { logger.info('SIGINT received, shutting down.'); process.exit(0); });
process.on('SIGTERM', () => { logger.info('SIGTERM received, shutting down.'); process.exit(0); });
