/**
 * Staff activity tracking — DB helpers.
 * All data lives in metrics.db (same DB as snapshots/sentiment).
 */

import { getDb } from './db';
import { logger } from '../logger';

// ── Default groups (seeded on first startup) ──────────────────────────────────

const DEFAULT_GROUPS = [
  { name: 'Community Managers', sort_order: 0 },
  { name: 'Moderators',         sort_order: 1 },
  { name: 'Helpers',            sort_order: 2 },
];

export function initStaffGroups(): void {
  const db = getDb();
  for (const g of DEFAULT_GROUPS) {
    db.prepare(`INSERT OR IGNORE INTO staff_groups (name, sort_order) VALUES (?, ?)`)
      .run(g.name, g.sort_order);
  }
}

// ── Group config ──────────────────────────────────────────────────────────────

export interface StaffGroup {
  id: number;
  name: string;
  sort_order: number;
}

export interface StaffGroupConfig extends StaffGroup {
  roles: string[];
  users: string[];
}

export function getStaffGroups(): StaffGroup[] {
  return getDb()
    .prepare(`SELECT * FROM staff_groups ORDER BY sort_order ASC`)
    .all() as StaffGroup[];
}

export function getStaffGroupConfig(): StaffGroupConfig[] {
  const db = getDb();
  return getStaffGroups().map(g => {
    const roles = (db.prepare(`SELECT role_id FROM staff_tracked_roles WHERE group_id = ?`).all(g.id) as { role_id: string }[]).map(r => r.role_id);
    const users = (db.prepare(`SELECT user_id FROM staff_tracked_users WHERE group_id = ?`).all(g.id) as { user_id: string }[]).map(r => r.user_id);
    return { ...g, roles, users };
  });
}

export function addRoleToGroup(groupId: number, roleId: string): void {
  getDb().prepare(`INSERT OR IGNORE INTO staff_tracked_roles (group_id, role_id) VALUES (?, ?)`).run(groupId, roleId);
}

export function removeRoleFromGroup(groupId: number, roleId: string): void {
  getDb().prepare(`DELETE FROM staff_tracked_roles WHERE group_id = ? AND role_id = ?`).run(groupId, roleId);
}

export function addUserToGroup(groupId: number, userId: string): void {
  getDb().prepare(`INSERT OR IGNORE INTO staff_tracked_users (group_id, user_id) VALUES (?, ?)`).run(groupId, userId);
}

export function removeUserFromGroup(groupId: number, userId: string): void {
  getDb().prepare(`DELETE FROM staff_tracked_users WHERE group_id = ? AND user_id = ?`).run(groupId, userId);
}

// ── Tracker lookups (used by staffTracker.ts) ─────────────────────────────────

/** Returns a map of roleId → groupId for all tracked roles. */
export function getTrackedRoleMap(): Map<string, number> {
  const rows = getDb()
    .prepare(`SELECT role_id, group_id FROM staff_tracked_roles`)
    .all() as { role_id: string; group_id: number }[];
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.role_id, r.group_id);
  return map;
}

/** Returns a map of userId → groupId for all explicitly tracked users. */
export function getTrackedUserMap(): Map<string, number> {
  const rows = getDb()
    .prepare(`SELECT user_id, group_id FROM staff_tracked_users`)
    .all() as { user_id: string; group_id: number }[];
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.user_id, r.group_id);
  return map;
}

// ── Event logging ─────────────────────────────────────────────────────────────

export interface StaffMessageEvent {
  user_id:      string;
  display_name: string;
  group_id:     number;
  channel_id:   string;
  channel_name: string;
  is_thread:    number;
  thread_id:    string | null;
  message_id:   string;
  created_at:   number;
}

export function logStaffMessage(event: StaffMessageEvent): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO staff_message_events
      (user_id, display_name, group_id, channel_id, channel_name, is_thread, thread_id, message_id, created_at)
    VALUES
      (@user_id, @display_name, @group_id, @channel_id, @channel_name, @is_thread, @thread_id, @message_id, @created_at)
  `).run(event);
}

// ── Activity queries ──────────────────────────────────────────────────────────

export interface StaffActivityRow {
  user_id:       string;
  display_name:  string;
  group_id:      number;
  group_name:    string;
  message_count: number;
  channel_count: number;
  thread_count:  number;
  last_activity: number;
  top_channel:   string | null;
}

export function getStaffActivity(days: number): StaffActivityRow[] {
  const cutoff = Date.now() - days * 86_400_000;
  const db = getDb();

  // Metrics per user
  const metrics = db.prepare(`
    SELECT
      user_id,
      MAX(display_name) AS display_name,
      COUNT(*) AS message_count,
      COUNT(DISTINCT channel_id) AS channel_count,
      COUNT(DISTINCT thread_id) AS thread_count,
      MAX(created_at) AS last_activity,
      (
        SELECT e2.channel_name FROM staff_message_events e2
        WHERE e2.user_id = e.user_id AND e2.created_at >= ?
        GROUP BY e2.channel_id ORDER BY COUNT(*) DESC LIMIT 1
      ) AS top_channel
    FROM staff_message_events e
    WHERE created_at >= ?
    GROUP BY user_id
    ORDER BY message_count DESC
  `).all(cutoff, cutoff) as Array<{
    user_id:       string;
    display_name:  string;
    message_count: number;
    channel_count: number;
    thread_count:  number;
    last_activity: number;
    top_channel:   string | null;
  }>;

  if (metrics.length === 0) return [];

  // Explicit group assignments (highest priority)
  const explicitMap = new Map<string, { group_id: number; group_name: string }>();
  (db.prepare(`
    SELECT stu.user_id, sg.id AS group_id, sg.name AS group_name
    FROM staff_tracked_users stu
    JOIN staff_groups sg ON sg.id = stu.group_id
  `).all() as Array<{ user_id: string; group_id: number; group_name: string }>)
    .forEach(r => explicitMap.set(r.user_id, r));

  // Group from most recent event (fallback for role-tracked users)
  const eventGroupMap = new Map<string, { group_id: number; group_name: string }>();
  (db.prepare(`
    SELECT e.user_id, e.group_id, sg.name AS group_name
    FROM staff_message_events e
    JOIN staff_groups sg ON sg.id = e.group_id
    WHERE e.created_at = (
      SELECT MAX(e2.created_at) FROM staff_message_events e2 WHERE e2.user_id = e.user_id
    )
    GROUP BY e.user_id
  `).all() as Array<{ user_id: string; group_id: number; group_name: string }>)
    .forEach(r => eventGroupMap.set(r.user_id, r));

  return metrics.map(m => {
    const group = explicitMap.get(m.user_id) ?? eventGroupMap.get(m.user_id) ?? { group_id: 0, group_name: 'Unknown' };
    return { ...m, ...group };
  });
}

export function getStaffActivityByMonth(year: number, month: number): StaffActivityRow[] {
  const start = Date.UTC(year, month - 1, 1);
  const end   = Date.UTC(year, month,     1); // exclusive
  const db    = getDb();

  const metrics = db.prepare(`
    SELECT
      user_id,
      MAX(display_name) AS display_name,
      COUNT(*) AS message_count,
      COUNT(DISTINCT channel_id) AS channel_count,
      COUNT(DISTINCT thread_id) AS thread_count,
      MAX(created_at) AS last_activity,
      (
        SELECT e2.channel_name FROM staff_message_events e2
        WHERE e2.user_id = e.user_id AND e2.created_at >= ? AND e2.created_at < ?
        GROUP BY e2.channel_id ORDER BY COUNT(*) DESC LIMIT 1
      ) AS top_channel
    FROM staff_message_events e
    WHERE created_at >= ? AND created_at < ?
    GROUP BY user_id
  `).all(start, end, start, end) as Array<{
    user_id:       string;
    display_name:  string;
    message_count: number;
    channel_count: number;
    thread_count:  number;
    last_activity: number;
    top_channel:   string | null;
  }>;

  const activeUserIds = new Set(metrics.map(m => m.user_id));

  // Explicit group assignments (highest priority)
  const explicitMap = new Map<string, { group_id: number; group_name: string }>();
  (db.prepare(`
    SELECT stu.user_id, sg.id AS group_id, sg.name AS group_name
    FROM staff_tracked_users stu
    JOIN staff_groups sg ON sg.id = stu.group_id
  `).all() as Array<{ user_id: string; group_id: number; group_name: string }>)
    .forEach(r => explicitMap.set(r.user_id, r));

  // Group from most recent event ever (fallback for role-tracked users)
  const eventGroupMap = new Map<string, { group_id: number; group_name: string }>();
  (db.prepare(`
    SELECT e.user_id, e.group_id, sg.name AS group_name
    FROM staff_message_events e
    JOIN staff_groups sg ON sg.id = e.group_id
    WHERE e.created_at = (
      SELECT MAX(e2.created_at) FROM staff_message_events e2 WHERE e2.user_id = e.user_id
    )
    GROUP BY e.user_id
  `).all() as Array<{ user_id: string; group_id: number; group_name: string }>)
    .forEach(r => eventGroupMap.set(r.user_id, r));

  // Active rows
  const activeRows: StaffActivityRow[] = metrics.map(m => {
    const group = explicitMap.get(m.user_id) ?? eventGroupMap.get(m.user_id) ?? { group_id: 0, group_name: 'Unknown' };
    return { ...m, ...group };
  });

  // Build full list of known Moderators + Helpers (for inactive detection)
  const knownUsers = new Map<string, { user_id: string; group_id: number; group_name: string; display_name: string }>();

  // From historical events
  (db.prepare(`
    SELECT e.user_id, sg.id AS group_id, sg.name AS group_name, MAX(e.display_name) AS display_name
    FROM staff_message_events e
    JOIN staff_groups sg ON sg.id = e.group_id
    WHERE sg.name IN ('Moderators', 'Helpers')
    GROUP BY e.user_id
  `).all() as Array<{ user_id: string; group_id: number; group_name: string; display_name: string }>)
    .forEach(r => knownUsers.set(r.user_id, r));

  // From explicit tracking (override group; keep historical display_name if available)
  (db.prepare(`
    SELECT stu.user_id, sg.id AS group_id, sg.name AS group_name
    FROM staff_tracked_users stu
    JOIN staff_groups sg ON sg.id = stu.group_id
    WHERE sg.name IN ('Moderators', 'Helpers')
  `).all() as Array<{ user_id: string; group_id: number; group_name: string }>)
    .forEach(r => {
      const existing = knownUsers.get(r.user_id);
      knownUsers.set(r.user_id, {
        user_id:      r.user_id,
        group_id:     r.group_id,
        group_name:   r.group_name,
        display_name: existing?.display_name ?? r.user_id,
      });
    });

  const inactiveRows: StaffActivityRow[] = [];
  for (const [userId, info] of knownUsers) {
    if (!activeUserIds.has(userId)) {
      inactiveRows.push({
        user_id:       userId,
        display_name:  info.display_name,
        group_id:      info.group_id,
        group_name:    info.group_name,
        message_count: 0,
        channel_count: 0,
        thread_count:  0,
        last_activity: 0,
        top_channel:   null,
      });
    }
  }

  return [...activeRows, ...inactiveRows];
}

/** Returns distinct {year, month} pairs that have at least one staff message event, ascending. */
export function getStaffActiveMonths(): Array<{ year: number; month: number }> {
  const rows = getDb().prepare(`
    SELECT DISTINCT
      CAST(strftime('%Y', datetime(created_at / 1000, 'unixepoch')) AS INTEGER) AS year,
      CAST(strftime('%m', datetime(created_at / 1000, 'unixepoch')) AS INTEGER) AS month
    FROM staff_message_events
    ORDER BY year ASC, month ASC
  `).all() as Array<{ year: number; month: number }>;
  return rows;
}

// ── Weekly snapshots ──────────────────────────────────────────────────────────

export function takeWeeklySnapshot(): void {
  const db = getDb();

  // week_start = the Monday 00:00 UTC of the week just ended
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon...
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  const thisMonday = new Date(now);
  thisMonday.setUTCDate(now.getUTCDate() - daysSinceMonday);
  thisMonday.setUTCHours(0, 0, 0, 0);
  const lastMonday = new Date(thisMonday);
  lastMonday.setUTCDate(thisMonday.getUTCDate() - 7);
  const weekStart = lastMonday.getTime();

  const activity = getStaffActivity(7);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO staff_weekly_snapshots
      (week_start, user_id, display_name, group_id, message_count, channel_count, thread_count, last_activity, top_channel)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const a of activity) {
      insert.run(weekStart, a.user_id, a.display_name, a.group_id, a.message_count, a.channel_count, a.thread_count, a.last_activity, a.top_channel);
    }
  })();

  logger.info(`[staffDb] Weekly snapshot taken — ${activity.length} users recorded`);
}

export function getWeeklySnapshots(limit = 12): Array<{ week_start: number; users: StaffActivityRow[] }> {
  const db = getDb();
  const weeks = db.prepare(`
    SELECT DISTINCT week_start FROM staff_weekly_snapshots ORDER BY week_start DESC LIMIT ?
  `).all(limit) as Array<{ week_start: number }>;

  return weeks.map(w => {
    const users = db.prepare(`
      SELECT s.*, sg.name AS group_name
      FROM staff_weekly_snapshots s
      JOIN staff_groups sg ON sg.id = s.group_id
      WHERE s.week_start = ?
      ORDER BY s.group_id ASC, s.message_count DESC
    `).all(w.week_start) as StaffActivityRow[];
    return { week_start: w.week_start, users };
  });
}
