/**
 * Real-time outage spike detector.
 *
 * Listens to Discord messageCreate events on the configured sentiment channels.
 * Maintains a sliding in-memory window of messages that match server/client
 * issue keywords. When the window exceeds the configured threshold (message
 * count + unique user count) it posts an alert to the staff alert channel and
 * observes a cooldown before the next alert can fire.
 *
 * No database reads/writes. No AI. Fires within seconds of the spike starting.
 */

import { Message, TextBasedChannel } from 'discord.js';
import { getDiscordClient } from '../api/discord';
import { getSetting, setSetting } from '../store/settingsDb';
import { config } from '../config';
import { logger } from '../logger';

// ── Alert destination ─────────────────────────────────────────────────────────

const ALERT_CHANNEL_ID = '1463655435897802752';
const ALERT_ROLE_ID    = '692027504528982086';

// ── Keywords ──────────────────────────────────────────────────────────────────

export const SPIKE_KEYWORD_GROUPS: Record<string, string[]> = {
  'Connection / Login': [
    'server down', 'servers down', 'server offline', 'servers offline',
    "can't connect", 'cant connect', 'cannot connect',
    'connection refused', 'connection error', 'connection lost', 'connection timed out',
    "can't login", 'cant login', 'login failed', 'login error', "can't log in",
    'stuck on loading', 'loading screen', 'authentication failed',
    'game is down', 'wows down',
  ],
  'Disconnections': [
    'disconnected', 'got disconnected', 'keeps disconnecting',
    "dc'd", 'got kicked', 'kicked from game', 'timed out', 'infinite loading',
  ],
  'Server Performance': [
    'lag spike', 'server lag', 'massive lag', 'ping spike',
    '999 ping', 'high ping', 'desync',
  ],
  'Maintenance': [
    'unscheduled maintenance', 'emergency maintenance',
    'server maintenance', 'servers under maintenance',
  ],
  'Crashes': [
    'game crash', 'client crash', 'game crashed', 'crash on login', 'crash on launch',
  ],
};

// ── Sliding window state ──────────────────────────────────────────────────────

interface WindowEntry {
  ts:            number;
  authorId:      string;
  matchedGroups: string[];
}

let slidingWindow: WindowEntry[] = [];
let lastAlertAt                  = 0;
let activeChannelSet             = new Set<string>();

export function refreshSpikeChannels(channelIds: string[]): void {
  activeChannelSet = new Set(channelIds);
}

// ── Keyword matching ──────────────────────────────────────────────────────────

function matchGroups(content: string): string[] {
  const lower   = content.toLowerCase();
  const matched = new Set<string>();
  for (const [group, keywords] of Object.entries(SPIKE_KEYWORD_GROUPS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matched.add(group);
        break;
      }
    }
  }
  return [...matched];
}

// ── Alert formatter ───────────────────────────────────────────────────────────

function buildAlertMessage(
  entries:        WindowEntry[],
  uniqueUsers:    number,
  windowMinutes:  number,
): string {
  const groupCounts: Record<string, number> = {};
  for (const entry of entries) {
    for (const g of entry.matchedGroups) {
      groupCounts[g] = (groupCounts[g] ?? 0) + 1;
    }
  }

  const sortedGroups = Object.entries(groupCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([g, c]) => `• **${g}** — ${c} message${c !== 1 ? 's' : ''}`);

  const timeStr = new Date().toLocaleString('en-GB', {
    timeZone:  'Europe/Prague',
    dateStyle: 'short',
    timeStyle: 'short',
  });

  return [
    `<@&${ALERT_ROLE_ID}> ⚠️ **Server issue spike detected** — ${timeStr} Prague time`,
    ``,
    `**${entries.length} messages** from **${uniqueUsers} unique players** in the last ${windowMinutes} min are reporting:`,
    ...sortedGroups,
    ``,
    `This may indicate an active server outage or widespread client issue.`,
  ].join('\n');
}

// ── Detector ──────────────────────────────────────────────────────────────────

export function startSpikeDetector(): void {
  const client = getDiscordClient();

  // Seed channel set from current config
  activeChannelSet = new Set(
    getSetting('sentiment_channel_ids', config.sentimentChannelIds.join(','))
      .split(',').map(s => s.trim()).filter(Boolean),
  );

  client.on('messageCreate', (message: Message) => {
    if (message.author.bot) return;

    // Same channel filter as the indexer
    const rootChannelId = message.channel.isThread()
      ? (message.channel.parentId ?? message.channelId)
      : message.channelId;
    if (!activeChannelSet.has(rootChannelId)) return;

    // Read live settings (no restart needed to change sensitivity)
    const enabled         = getSetting('spike_alert_enabled', 'true') === 'true';
    if (!enabled) return;

    const windowMinutes   = Math.max(1, parseInt(getSetting('spike_alert_window_minutes',   '10'), 10));
    const threshold       = Math.max(1, parseInt(getSetting('spike_alert_threshold',        '8'),  10));
    const minUsers        = Math.max(1, parseInt(getSetting('spike_alert_min_users',        '5'),  10));
    const cooldownMinutes = Math.max(1, parseInt(getSetting('spike_alert_cooldown_minutes', '45'), 10));

    const matched = matchGroups(message.content);
    if (matched.length === 0) return;

    const now = Date.now();
    slidingWindow.push({ ts: now, authorId: message.author.id, matchedGroups: matched });

    // Prune entries outside the window
    const windowMs = windowMinutes * 60 * 1000;
    slidingWindow   = slidingWindow.filter(e => now - e.ts <= windowMs);

    const uniqueUsers = new Set(slidingWindow.map(e => e.authorId)).size;

    if (slidingWindow.length < threshold)                       return;
    if (uniqueUsers < minUsers)                                 return;
    if (now - lastAlertAt < cooldownMinutes * 60 * 1000)        return;

    // Fire
    lastAlertAt = now;
    const snapshot = [...slidingWindow];
    const alertText = buildAlertMessage(snapshot, uniqueUsers, windowMinutes);

    // Persist for Overview page
    const groupCounts: Record<string, number> = {};
    for (const entry of snapshot) {
      for (const g of entry.matchedGroups) {
        groupCounts[g] = (groupCounts[g] ?? 0) + 1;
      }
    }
    setSetting('last_spike_alert', JSON.stringify({
      fired_at:      new Date(now).toISOString(),
      message_count: snapshot.length,
      unique_users:  uniqueUsers,
      window_minutes: windowMinutes,
      categories:    groupCounts,
    }));

    void (async () => {
      try {
        const ch = await client.channels.fetch(ALERT_CHANNEL_ID) as TextBasedChannel | null;
        if (ch && 'send' in ch) {
          await ch.send(alertText);
          logger.info(
            `[spikeDetector] Alert fired — ${snapshot.length} msgs, ${uniqueUsers} users`,
          );
        }
      } catch (err) {
        logger.error('[spikeDetector] Failed to send alert:', err);
      }
    })();
  });

  logger.info('[spikeDetector] Real-time outage spike detector active');
}
