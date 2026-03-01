/**
 * Metrics collector — fetches all Statbot data for a given time window
 * and saves a snapshot to SQLite.
 */

import {
  getMessages,
  getActiveMembers,
  getJoins,
  getLeaves,
  getChannelStats,
  ChannelStat,
} from '../api/statbot';
import {
  insertSnapshot,
  insertChannelStats,
  getLatestPlayerRoleSnapshot,
} from '../store/db';
import { logger } from '../logger';

export interface CollectedMetrics {
  snapshotId:       number;
  from:             Date;
  to:               Date;
  messages:         number | null;
  activeMembers:    number | null;
  joins:            number | null;
  leaves:           number | null;
  playerRoleCount:  number | null;
  channelStats:     ChannelStat[];
}

/**
 * Fetch all metrics from Statbot for the given window, save to DB, and return.
 */
export async function collectMetrics(
  from: Date,
  to:   Date,
  period: 'daily' | 'monthly',
): Promise<CollectedMetrics> {
  logger.info(`[metrics] Collecting ${period} metrics from ${from.toISOString()} to ${to.toISOString()}`);

  // Fetch all data in parallel; each call returns null on failure (graceful degradation)
  const [messagesRes, activeMembersRes, joinsRes, leavesRes, channelRes] = await Promise.allSettled([
    getMessages(from, to),
    getActiveMembers(from, to),
    getJoins(from, to),
    getLeaves(from, to),
    getChannelStats(from, to),
  ]);

  const messages      = settled(messagesRes)?.count      ?? null;
  const activeMembers = settled(activeMembersRes)?.count ?? null;
  const joins         = settled(joinsRes)?.count         ?? null;
  const leaves        = settled(leavesRes)?.count        ?? null;
  const channels      = settled(channelRes) ?? [];

  // @Player role count from our own DB (no Statbot needed)
  const todayStr    = to.toISOString().slice(0, 10);
  const roleSnap    = getLatestPlayerRoleSnapshot();
  const playerRoleCount = roleSnap?.total_count ?? null;

  const rawJson = JSON.stringify({ messages, activeMembers, joins, leaves });

  // Persist snapshot
  const snapshotId = insertSnapshot({
    taken_at:          new Date().toISOString(),
    period,
    messages,
    active_members:    activeMembers,
    joins,
    leaves,
    player_role_count: playerRoleCount,
    raw_json:          rawJson,
  });

  if (channels.length > 0) {
    insertChannelStats(snapshotId, channels);
  }

  logger.info(`[metrics] Snapshot #${snapshotId} saved: messages=${messages}, activeMembers=${activeMembers}, joins=${joins}, leaves=${leaves}, playerRole=${playerRoleCount}`);

  return {
    snapshotId,
    from,
    to,
    messages,
    activeMembers,
    joins,
    leaves,
    playerRoleCount,
    channelStats: channels,
  };
}

// ── Date window helpers ───────────────────────────────────────────────────────

/** Returns [start, end] for yesterday (calendar day in UTC). */
export function yesterdayWindow(): [Date, Date] {
  // Use Europe/Berlin calendar date to match the cron timezone.
  // The cron fires at 00:00 CET = 23:00 UTC, so UTC date is still the previous day —
  // using UTC directly would give the wrong day. Berlin date gives the correct result.
  const berlinDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()); // e.g. "2026-03-02"
  const [y, m, d] = berlinDateStr.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, d - 1));
  const to   = new Date(Date.UTC(y, m - 1, d) - 1);
  return [from, to];
}

/** Returns [start, end] for the previous calendar month in Europe/Berlin timezone. */
export function lastMonthWindow(): [Date, Date] {
  // Same timezone fix as yesterdayWindow — use Berlin date, not UTC date.
  const berlinDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()); // e.g. "2026-04-01"
  const [y, m] = berlinDateStr.split('-').map(Number); // m is 1-indexed
  const year  = m === 1 ? y - 1 : y;
  const month = m === 1 ? 11 : m - 2; // 0-indexed, one month back
  const from  = new Date(Date.UTC(year, month, 1));
  const to    = new Date(Date.UTC(year, month + 1, 1) - 1);
  return [from, to];
}

// ── Utility ───────────────────────────────────────────────────────────────────

function settled<T>(result: PromiseSettledResult<T>): T | null {
  if (result.status === 'fulfilled') return result.value;
  logger.warn('[metrics] A Statbot call failed:', (result as PromiseRejectedResult).reason?.message);
  return null;
}
