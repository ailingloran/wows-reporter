/**
 * Bot settings store — persisted in metrics.db as key-value pairs.
 * Acts as a runtime override layer on top of env vars, allowing settings
 * to be changed via the dashboard without redeploying the bot.
 */

import { config } from '../config';
import { getDb } from './db';

function extractHour(cronExpr: string): number {
  // "0 17 * * *" → field at index 1 is the hour
  return parseInt(cronExpr.split(' ')[1] ?? '0', 10);
}

// Default values seeded from env vars / config on first run
const DEFAULTS: Record<string, string> = {
  daily_hour:              String(extractHour(config.dailyCron)),
  sentiment_hour:          String(extractHour(config.sentimentCron)),
  daily_enabled:           'true',
  sentiment_enabled:       'true',
  daily_delivery:          config.dailyDelivery,
  sentiment_message_limit: String(config.sentimentMessageLimit),
  sentiment_channel_ids:   config.sentimentChannelIds.join(','),
  min_index_messages:      '500',
  staff_channel_id:        config.discordStaffChannelId,
  pulse_model:             'gpt-5.1',
  chat_model:              'gpt-5.1',
  narrative_ai_enabled:    'false',
  weekly_pulse_enabled:         'true',
  spike_alert_enabled:          'true',
  spike_alert_threshold:        '8',
  spike_alert_window_minutes:   '10',
  spike_alert_cooldown_minutes: '45',
  spike_alert_min_users:        '5',
  compliance_watched_users:     '["282918131762987008","629846346244947971"]',

  // ── Bug Report Tracker ──────────────────────────────────────────────────────
  // bug_auto_message_enabled: standalone — posts instructions in every new
  //   thread in the configured forum channels. Works without full tracking.
  // bug_tracker_enabled: full workflow — tags, CM claim button, DB records,
  //   reminders. Requires bug_cm_group_id and tags pre-created on Discord.
  bug_auto_message_enabled:    'false',
  bug_tracker_enabled:         'false',
  bug_forum_channel_ids:       '',       // comma-separated Discord forum channel IDs
  bug_notification_channel_id: '',       // staff channel for claim/reminder pings
  bug_cm_group_id:             '',       // staff_groups.id (as string) of CM group
  bug_reminder_days:           '2',      // days of CM inactivity before a reminder fires
  bug_new_tag_name:            'NEW BUG',  // must exist on the forum channel
  bug_claimed_tag_name:        'CLAIMED',  // must exist on the forum channel
  bug_startup_scan_enabled:    'true',
  bug_instructions_text:       [
    '**How to report a bug:**',
    '',
    '• Review prior posts before creating a new one to avoid duplicate issues',
    '• Create a new post:',
    '  ○ Add a short title describing the bug/issue',
    '  ○ Add relevant description of the bug',
    '  ○ Add specific steps to recreate the bug',
    '  ○ Add screenshots + video recording + replay when relevant',
    '  ○ Add a WGCheck **(required)**',
    '  ○ Select appropriate tag',
    '• Click Post',
    '',
    'The Moderators reserve the right to lock posts which do not follow channel guidelines or are duplicates of previous reports.',
    '',
    '*Please ensure the bug is not related to installed mods before posting. Launch the game in safe mode and see if the problem persists.*',
  ].join('\n'),
};

export function initSettings(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Seed defaults only for keys that have no existing value
  const stmt = getDb().prepare(
    `INSERT OR IGNORE INTO bot_settings (key, value) VALUES (?, ?)`,
  );
  const seed = getDb().transaction(() => {
    for (const [k, v] of Object.entries(DEFAULTS)) {
      stmt.run(k, v);
    }
  });
  seed();
}

export function getSetting(key: string, fallback = ''): string {
  const row = getDb()
    .prepare(`SELECT value FROM bot_settings WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO bot_settings (key, value) VALUES (?, ?)`,
  ).run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb()
    .prepare(`SELECT key, value FROM bot_settings`)
    .all() as { key: string; value: string }[];
  const result: Record<string, string> = { ...DEFAULTS };
  for (const row of rows) result[row.key] = row.value;
  return result;
}
