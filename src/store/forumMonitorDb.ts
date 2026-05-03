/**
 * Forum Monitor DB helpers.
 * Tracks which threads have already been processed (notified or CM-resolved)
 * so the hourly check doesn't fire a second notification for the same thread.
 */

import { getDb } from './db';

export function isForumThreadDone(threadId: string): boolean {
  return getDb()
    .prepare(`SELECT 1 FROM forum_monitor_done WHERE thread_id = ?`)
    .get(threadId) !== undefined;
}

export function markForumThreadDone(threadId: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO forum_monitor_done (thread_id, resolved_at) VALUES (?, ?)`)
    .run(threadId, Date.now());
}
