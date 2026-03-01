/**
 * WoWS Discord Reporting Pack Generator
 * Entry point — initialises DB, Discord client, cron scheduler, and optional dashboard.
 */

import 'dotenv/config';
import { initDb } from './store/db';
import { initDiscordClient, getDiscordClient } from './api/discord';
import { registerSchedules } from './scheduler';
import { runDailyReport } from './reports/daily';
import { runMonthlyReport } from './reports/monthly';
import { startDashboard } from './dashboard/server';
import { config } from './config';
import { logger } from './logger';

async function main() {
  logger.info('=== WoWS Reporter starting ===');

  // 1. Initialise SQLite database (creates tables if not exist)
  initDb();
  logger.info('Database initialised');

  // 2. Connect Discord bot
  await initDiscordClient();
  logger.info('Discord client ready');

  const args = process.argv.slice(2);

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

  // ── Normal operation ─────────────────────────────────────────────────────────
  // 3. Register cron jobs
  registerSchedules();
  logger.info(`Cron jobs registered. Daily: "${config.dailyCron}", Monthly: "${config.monthlyCron}" (Europe/Berlin)`);

  // 4. Start optional web dashboard
  if (config.dailyDelivery === 'dashboard' || config.dailyDelivery === 'both' ||
      config.monthlyDelivery === 'dashboard' || config.monthlyDelivery === 'both') {
    startDashboard();
    logger.info(`Dashboard listening on port ${config.dashboardPort}`);
  }

  logger.info('=== WoWS Reporter running. Waiting for scheduled events. ===');
}

main().catch((err) => {
  logger.error('Fatal error during startup:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT',  () => { logger.info('SIGINT received, shutting down.'); process.exit(0); });
process.on('SIGTERM', () => { logger.info('SIGTERM received, shutting down.'); process.exit(0); });
