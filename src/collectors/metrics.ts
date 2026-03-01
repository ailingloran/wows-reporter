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
  const now  = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const to   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 1);
  return [from, to];
}

/** Returns [start, end] for the previous calendar month in UTC. */
export function lastMonthWindow(): [Date, Date] {
  const now   = new Date();
  const year  = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const month = now.getUTCMonth() === 0 ? 11 : now.getUTCMonth() - 1;
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
