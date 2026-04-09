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
