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
  // Snapshot the @Player role count first so the report always has fresh data.
  cron.schedule(config.dailyCron, async () => {
    logger.info('[scheduler] Daily report triggered');
    try {
      const client = getDiscordClient();
      const guild  = await client.guilds.fetch(config.statbotGuildId);
      await snapshotPlayerRole(guild);
      logger.info('[scheduler] @Player role snapshot complete');

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

  // ── Community Pulse (sentiment) report ──────────────────────────────────────
  cron.schedule(config.sentimentCron, async () => {
    logger.info('[scheduler] Community Pulse report triggered');
    try {
      const { runSentimentReport } = await import('./reports/sentiment');
      await runSentimentReport();
      logger.info('[scheduler] Community Pulse report complete');
    } catch (err) {
      logger.error('[scheduler] Community Pulse report failed:', err);
    }
  }, { timezone: TZ });
}
