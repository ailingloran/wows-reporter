/**
 * Cron job definitions.
 * All jobs use timezone: 'Europe/Berlin' so DST transitions are handled automatically.
 * CET = UTC+1 (winter), CEST = UTC+2 (summer).
 */

import cron from 'node-cron';
import { config } from './config';
import { logger } from './logger';
import { runDailyReport } from './reports/daily';
import { runMonthlyReport } from './reports/monthly';
import { snapshotPlayerRole } from './collectors/memberTracker';
import { getDiscordClient } from './api/discord';

const TZ = 'Europe/Berlin';

export function registerSchedules(): void {
  // ── Daily report ────────────────────────────────────────────────────────────
  cron.schedule(config.dailyCron, async () => {
    logger.info('[scheduler] Daily report triggered');
    try {
      await runDailyReport();
      logger.info('[scheduler] Daily report complete');
    } catch (err) {
      logger.error('[scheduler] Daily report failed:', err);
    }
  }, { timezone: TZ });

  // ── Monthly report ──────────────────────────────────────────────────────────
  cron.schedule(config.monthlyCron, async () => {
    logger.info('[scheduler] Monthly report triggered');
    try {
      await runMonthlyReport();
      logger.info('[scheduler] Monthly report complete');
    } catch (err) {
      logger.error('[scheduler] Monthly report failed:', err);
    }
  }, { timezone: TZ });

  // ── @Player role nightly snapshot (5 minutes after daily cron) ──────────────
  // This runs just after the daily report so the count is fresh in the DB.
  cron.schedule('5 0 * * *', async () => {
    logger.info('[scheduler] @Player role snapshot triggered');
    try {
      const client = getDiscordClient();
      const guild  = await client.guilds.fetch(config.statbotGuildId);
      await snapshotPlayerRole(guild);
      logger.info('[scheduler] @Player role snapshot complete');
    } catch (err) {
      logger.error('[scheduler] @Player role snapshot failed:', err);
    }
  }, { timezone: TZ });
}
