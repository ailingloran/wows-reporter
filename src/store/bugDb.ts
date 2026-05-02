/**
 * Bug Report DB helpers.
 * All queries operate on the bug_reports table (defined in schema.sql)
 * and the existing staff_message_events table for CM activity checks.
 * No Discord imports — pure SQLite access layer.
 */

import { getDb } from './db';

export interface BugReportRow {
  thread_id:        string;
  forum_channel_id: string;
  title:            string;
  status:           'new' | 'claimed';
  claimed_by_id:    string | null;
  claimed_by_name:  string | null;
  claimed_at:       number | null;       // Unix ms
  bot_message_id:   string | null;
  created_at:       number;              // Unix ms
  last_reminder_at: number | null;       // Unix ms
  reminder_count:   number;
}

// ── Write helpers ─────────────────────────────────────────────────────────────

/** Insert or replace a bug report row. reminder_count defaults to 0 on insert. */
export function upsertBugReport(
  report: Omit<BugReportRow, 'reminder_count'>,
): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO bug_reports
      (thread_id, forum_channel_id, title, status,
       claimed_by_id, claimed_by_name, claimed_at,
       bot_message_id, created_at, last_reminder_at, reminder_count)
    VALUES
      (@thread_id, @forum_channel_id, @title, @status,
       @claimed_by_id, @claimed_by_name, @claimed_at,
       @bot_message_id, @created_at, @last_reminder_at,
       COALESCE((SELECT reminder_count FROM bug_reports WHERE thread_id = @thread_id), 0))
  `).run(report);
}

/** Mark a bug report as claimed by a CM. */
export function claimBugReport(
  threadId:    string,
  userId:      string,
  displayName: string,
): void {
  getDb().prepare(`
    UPDATE bug_reports
    SET status = 'claimed',
        claimed_by_id   = ?,
        claimed_by_name = ?,
        claimed_at      = ?
    WHERE thread_id = ?
  `).run(userId, displayName, Date.now(), threadId);
}

/**
 * Store the bot_message_id after posting the auto-message.
 * Called separately from upsertBugReport because the message ID isn't
 * known until after the thread.send() resolves.
 */
export function setBotMessageId(threadId: string, messageId: string): void {
  getDb().prepare(`
    UPDATE bug_reports SET bot_message_id = ? WHERE thread_id = ?
  `).run(messageId, threadId);
}

/** Record that a reminder was sent for a bug report. */
export function recordReminder(threadId: string): void {
  getDb().prepare(`
    UPDATE bug_reports
    SET last_reminder_at = ?,
        reminder_count   = reminder_count + 1
    WHERE thread_id = ?
  `).run(Date.now(), threadId);
}

/** Remove a bug report from tracking (does not touch Discord). */
export function deleteBugReport(threadId: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM bug_reports WHERE thread_id = ?`)
    .run(threadId);
  return result.changes > 0;
}

// ── Read helpers ──────────────────────────────────────────────────────────────

export function getBugReport(threadId: string): BugReportRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM bug_reports WHERE thread_id = ?`)
    .get(threadId) as BugReportRow | undefined;
}

export function isThreadTracked(threadId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM bug_reports WHERE thread_id = ?`)
    .get(threadId);
  return row !== undefined;
}

export function getBugReports(opts: {
  status?: string;
  limit?: number;
} = {}): BugReportRow[] {
  const { status, limit = 100 } = opts;
  if (status) {
    return getDb()
      .prepare(`SELECT * FROM bug_reports WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
      .all(status, limit) as BugReportRow[];
  }
  return getDb()
    .prepare(`SELECT * FROM bug_reports ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as BugReportRow[];
}

/**
 * Return claimed bug reports where no message from the configured CM group
 * appears in staff_message_events for that thread since `cutoffMs`.
 * Also applies to bugs where last_reminder_at is null (never reminded) or
 * older than cutoffMs (reminder due again).
 *
 * Uses the existing staff_message_events table — no extra activity tracking needed.
 */
// ── CM tag map ────────────────────────────────────────────────────────────────
// Maps Discord user IDs to personal forum tag names for specific CMs.
// Only CMs listed here get a personal tag applied on claim.
// The generic CLAIMED tag is always applied regardless.

export interface CmTagRow {
  user_id:  string;
  tag_name: string;
}

/** Returns the full userId → tagName map (used by bugTracker at claim time). */
export function getCmTagMap(): Map<string, string> {
  const rows = getDb()
    .prepare(`SELECT user_id, tag_name FROM bug_cm_tags`)
    .all() as CmTagRow[];
  return new Map(rows.map(r => [r.user_id, r.tag_name]));
}

/** Returns all CM tag rows ordered by user_id (for the dashboard list). */
export function getCmTags(): CmTagRow[] {
  return getDb()
    .prepare(`SELECT * FROM bug_cm_tags ORDER BY user_id`)
    .all() as CmTagRow[];
}

/** Insert or update a CM → tag mapping. */
export function upsertCmTag(userId: string, tagName: string): void {
  getDb()
    .prepare(`INSERT OR REPLACE INTO bug_cm_tags (user_id, tag_name) VALUES (?, ?)`)
    .run(userId, tagName);
}

/** Remove a CM tag mapping. Returns true if a row was deleted. */
export function deleteCmTag(userId: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM bug_cm_tags WHERE user_id = ?`)
    .run(userId);
  return result.changes > 0;
}

export function getStaleClaimedBugs(
  cmGroupId: number,
  cutoffMs:  number,
): BugReportRow[] {
  return getDb().prepare(`
    SELECT br.* FROM bug_reports br
    WHERE br.status = 'claimed'
      AND br.claimed_at < @cutoffMs
      AND (br.last_reminder_at IS NULL OR br.last_reminder_at < @cutoffMs)
      AND NOT EXISTS (
        SELECT 1 FROM staff_message_events sme
        WHERE sme.thread_id = br.thread_id
          AND sme.group_id  = @cmGroupId
          AND sme.created_at >= @cutoffMs
      )
    ORDER BY br.claimed_at ASC
  `).all({ cmGroupId, cutoffMs }) as BugReportRow[];
}
