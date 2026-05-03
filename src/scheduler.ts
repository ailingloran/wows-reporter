/**
 * Cron job definitions.
 * All jobs use timezone: 'Europe/Berlin' so DST transitions are handled automatically.
 * CET = UTC+1 (winter), CEST = UTC+2 (summer) — same as Prague.
 *
 * Hours are read from bot_settings at startup and can be hot-reloaded via
 * rescheduleReport() without restarting the bot.
 */

import cron from 'node-cron';
import { logger } from './logger';
import { getSetting } from './store/settingsDb';
import { getDiscordClient } from './api/discord';

const TZ = 'Europe/Berlin';

// ── Task references (kept so they can be stopped on reschedule) ───────────────

let dailyTask:         cron.ScheduledTask | null = null;
let sentimentTask:     cron.ScheduledTask | null = null;
let weeklyPulseTask:   cron.ScheduledTask | null = null;
let staffSnapshotTask: cron.ScheduledTask | null = null;
let narrativeTask:     cron.ScheduledTask | null = null;
let narrativeAiTask:   cron.ScheduledTask | null = null;
let bugReminderTask:        cron.ScheduledTask | null = null;
let forumMonitorTask:       cron.ScheduledTask | null = null;

// ── Callbacks (named so they can be reused when rescheduling) ─────────────────

async function dailyCallback() {
  if (getSetting('daily_enabled', 'true') !== 'true') {
    logger.info('[scheduler] Daily report skipped (disabled via settings)');
    return;
  }
  logger.info('[scheduler] Daily report triggered');
  try {
    const { snapshotPlayerRole } = await import('./collectors/memberTracker');
    const { runDailyReport }    = await import('./reports/daily');
    const client = getDiscordClient();
    const { config } = await import('./config');
    const guild = await client.guilds.fetch(config.statbotGuildId);
    await snapshotPlayerRole(guild);
    logger.info('[scheduler] @Player role snapshot complete');
    await runDailyReport();
    logger.info('[scheduler] Daily report complete');
  } catch (err) {
    logger.error('[scheduler] Daily report failed:', err);
  }
}

async function sentimentCallback() {
  if (getSetting('sentiment_enabled', 'true') !== 'true') {
    logger.info('[scheduler] Community Pulse skipped (disabled via settings)');
    return;
  }
  logger.info('[scheduler] Community Pulse report triggered');
  try {
    const { runSentimentReport } = await import('./reports/sentiment');
    await runSentimentReport();
    logger.info('[scheduler] Community Pulse report complete');
  } catch (err) {
    logger.error('[scheduler] Community Pulse report failed:', err);
  }
}

async function narrativeCallback() {
  logger.info('[scheduler] Narrative drift daily processing triggered');
  try {
    const { processYesterdayFromMessages } = await import('./store/narrativeDb');
    processYesterdayFromMessages();
    logger.info('[scheduler] Narrative drift processing complete');
  } catch (err) {
    logger.error('[scheduler] Narrative drift processing failed:', err);
  }
}

// ── AI Narrative Drift (only runs when NARRATIVE_AI_ENABLED=true) ──────────────

async function narrativeAiCallback() {
  if (getSetting('narrative_ai_enabled', 'false') !== 'true') {
    logger.debug('[scheduler] AI Narrative drift skipped (disabled via settings)');
    return;
  }
  logger.info('[scheduler] AI Narrative drift processing triggered');
  try {
    const { processYesterdayFromMessagesAI } = await import('./store/narrativeAiDb');
    await processYesterdayFromMessagesAI();
    logger.info('[scheduler] AI Narrative drift processing complete');
  } catch (err) {
    logger.error('[scheduler] AI Narrative drift processing failed:', err);
  }
}

async function weeklyPulseCallback() {
  if (getSetting('weekly_pulse_enabled', 'true') !== 'true') {
    logger.info('[scheduler] Weekly Pulse Summary skipped (disabled via settings)');
    return;
  }
  logger.info('[scheduler] Weekly Pulse Summary triggered');
  try {
    const { runWeeklyPulseSummary } = await import('./reports/weeklyPulse');
    await runWeeklyPulseSummary();
    logger.info('[scheduler] Weekly Pulse Summary complete');
  } catch (err) {
    logger.error('[scheduler] Weekly Pulse Summary failed:', err);
  }
}

async function staffSnapshotCallback() {
  logger.info('[scheduler] Staff weekly snapshot triggered');
  try {
    const { takeWeeklySnapshot } = await import('./store/staffDb');
    takeWeeklySnapshot();
    logger.info('[scheduler] Staff weekly snapshot complete');
  } catch (err) {
    logger.error('[scheduler] Staff weekly snapshot failed:', err);
  }
}

async function forumMonitorCallback() {
  try {
    const { runForumMonitorCheck } = await import('./forumMonitor');
    await runForumMonitorCheck();
  } catch (err) {
    logger.error('[scheduler] Forum monitor check failed:', err);
  }
}

async function bugReminderCallback() {
  if (getSetting('bug_tracker_enabled', 'false') !== 'true') return;
  logger.info('[scheduler] Bug report reminder check triggered');
  try {
    const { runBugReminders } = await import('./bugTracker');
    await runBugReminders();
    logger.info('[scheduler] Bug report reminder check complete');
  } catch (err) {
    logger.error('[scheduler] Bug report reminder check failed:', err);
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerSchedules(): void {
  const dh = parseInt(getSetting('daily_hour',     '0'),  10);
  const sh = parseInt(getSetting('sentiment_hour', '17'), 10);

  dailyTask        = cron.schedule(`0 ${dh} * * *`,   dailyCallback,        { timezone: TZ });
  sentimentTask    = cron.schedule(`0 ${sh} * * *`,   sentimentCallback,    { timezone: TZ });
  // Weekly Pulse Summary — every Monday at 12:00 CET, summarises the past 7 daily pulses
  weeklyPulseTask  = cron.schedule(`0 12 * * 1`,      weeklyPulseCallback,  { timezone: TZ });
  staffSnapshotTask = cron.schedule(`0 0 * * 1`,      staffSnapshotCallback, { timezone: TZ });
  // Narrative drift runs at 01:00 CET daily — independent of Community Pulse
  narrativeTask    = cron.schedule(`0 1 * * *`,        narrativeCallback,    { timezone: TZ });

  // AI Narrative Drift runs at 01:30 CET daily — skips if narrative_ai_enabled=false in settings.
  // To remove entirely: delete this line + narrativeAiCallback + narrativeAiDb.ts.
  narrativeAiTask = cron.schedule(`30 1 * * *`, narrativeAiCallback, { timezone: TZ });

  // Bug report reminder check — 09:00 CET daily.
  // Skips automatically when bug_tracker_enabled=false in settings.
  bugReminderTask = cron.schedule('0 9 * * *', bugReminderCallback, { timezone: TZ });

  // Forum response monitor — hourly Mon–Fri (Europe/Berlin = Prague).
  // Monday's runs naturally catch threads created over the weekend.
  // Skips automatically when forum_monitor_enabled=false in settings.
  forumMonitorTask = cron.schedule('0 * * * 1-5', forumMonitorCallback, { timezone: TZ });

  logger.info(
    `[scheduler] Daily at ${dh}:00, Community Pulse at ${sh}:00, ` +
    `Weekly Pulse Mondays 12:00 (Europe/Berlin)`,
  );
}

// ── Hot-reload ────────────────────────────────────────────────────────────────

export function rescheduleReport(type: 'daily' | 'sentiment', hour: number): void {
  const h = Math.max(0, Math.min(23, Math.round(hour)));

  if (type === 'daily') {
    dailyTask?.stop();
    dailyTask = cron.schedule(`0 ${h} * * *`, dailyCallback, { timezone: TZ });
    logger.info(`[scheduler] Daily rescheduled to ${h}:00 (Europe/Berlin)`);
  } else {
    sentimentTask?.stop();
    sentimentTask = cron.schedule(`0 ${h} * * *`, sentimentCallback, { timezone: TZ });
    logger.info(`[scheduler] Community Pulse rescheduled to ${h}:00 (Europe/Berlin)`);
  }
}
