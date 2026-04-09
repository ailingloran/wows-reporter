/**
 * Compliance / Tone Monitor — database layer.
 * Stores message content from watched users and AI review results.
 */

import { getDb } from './db';
import { getSetting, setSetting } from './settingsDb';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ComplianceMessage {
  id:           number;
  message_id:   string;
  user_id:      string;
  display_name: string;
  channel_id:   string;
  channel_name: string;
  content:      string;
  created_at:   number;
}

export interface ComplianceReview {
  id:                number;
  message_id:        string;
  reviewed_at:       number;
  helpfulness_score: number;
  tone_score:        number;
  issues:            string[];
  summary:           string;
  flagged:           boolean;
}

export interface ComplianceMessageWithReview extends ComplianceMessage {
  review: ComplianceReview | null;
}

export interface ComplianceUserStats {
  user_id:         string;
  display_name:    string;
  total_messages:  number;
  reviewed_count:  number;
  flagged_count:   number;
  avg_helpfulness: number | null;
  avg_tone:        number | null;
}

export interface AiComplianceResult {
  message_id:        string;
  helpfulness_score: number;
  tone_score:        number;
  issues:            string[];
  summary:           string;
  flagged:           boolean;
}

// ── Raw DB row shapes ─────────────────────────────────────────────────────────

interface RawReview {
  id:                number;
  message_id:        string;
  reviewed_at:       number;
  helpfulness_score: number;
  tone_score:        number;
  issues:            string;
  summary:           string;
  flagged:           number;
}

interface RawMessageWithReview extends ComplianceMessage {
  r_id:                number | null;
  r_message_id:        string | null;
  r_reviewed_at:       number | null;
  r_helpfulness_score: number | null;
  r_tone_score:        number | null;
  r_issues:            string | null;
  r_summary:           string | null;
  r_flagged:           number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function deserializeReview(row: RawReview): ComplianceReview {
  return {
    id:                row.id,
    message_id:        row.message_id,
    reviewed_at:       row.reviewed_at,
    helpfulness_score: row.helpfulness_score,
    tone_score:        row.tone_score,
    issues:            JSON.parse(row.issues) as string[],
    summary:           row.summary,
    flagged:           row.flagged === 1,
  };
}

function deserializeMessageWithReview(row: RawMessageWithReview): ComplianceMessageWithReview {
  const msg: ComplianceMessage = {
    id:           row.id,
    message_id:   row.message_id,
    user_id:      row.user_id,
    display_name: row.display_name,
    channel_id:   row.channel_id,
    channel_name: row.channel_name,
    content:      row.content,
    created_at:   row.created_at,
  };

  const review: ComplianceReview | null = row.r_id !== null ? {
    id:                row.r_id,
    message_id:        row.r_message_id!,
    reviewed_at:       row.r_reviewed_at!,
    helpfulness_score: row.r_helpfulness_score!,
    tone_score:        row.r_tone_score!,
    issues:            JSON.parse(row.r_issues ?? '[]') as string[],
    summary:           row.r_summary!,
    flagged:           row.r_flagged === 1,
  } : null;

  return { ...msg, review };
}

// ── Writes ────────────────────────────────────────────────────────────────────

export function insertComplianceMessage(msg: Omit<ComplianceMessage, 'id'>): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO compliance_messages
      (message_id, user_id, display_name, channel_id, channel_name, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(msg.message_id, msg.user_id, msg.display_name, msg.channel_id, msg.channel_name, msg.content, msg.created_at);
}

export function insertComplianceReview(result: AiComplianceResult): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO compliance_reviews
      (message_id, reviewed_at, helpfulness_score, tone_score, issues, summary, flagged)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.message_id,
    Date.now(),
    result.helpfulness_score,
    result.tone_score,
    JSON.stringify(result.issues),
    result.summary,
    result.flagged ? 1 : 0,
  );
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export function getComplianceMessages(opts: {
  userId?:      string;
  flaggedOnly?: boolean;
  windowHours?: number;   // 0 = all time
  minLength?:   number;   // minimum content length in characters
  limit?:       number;
  offset?:      number;
}): { messages: ComplianceMessageWithReview[]; total: number } {
  const { userId, flaggedOnly = false, windowHours = 24, minLength = 30, limit = 30, offset = 0 } = opts;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (userId) {
    conditions.push('cm.user_id = ?');
    params.push(userId);
  }
  if (flaggedOnly) {
    conditions.push('cr.flagged = 1');
  }
  if (windowHours > 0) {
    conditions.push('cm.created_at > ?');
    params.push(Date.now() - windowHours * 3_600_000);
  }
  if (minLength > 0) {
    conditions.push('LENGTH(cm.content) >= ?');
    params.push(minLength);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = getDb().prepare(`
    SELECT
      cm.*,
      cr.id          AS r_id,
      cr.message_id  AS r_message_id,
      cr.reviewed_at AS r_reviewed_at,
      cr.helpfulness_score AS r_helpfulness_score,
      cr.tone_score  AS r_tone_score,
      cr.issues      AS r_issues,
      cr.summary     AS r_summary,
      cr.flagged     AS r_flagged
    FROM compliance_messages cm
    LEFT JOIN compliance_reviews cr ON cr.message_id = cm.message_id
    ${where}
    ORDER BY cm.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as RawMessageWithReview[];

  const countRow = getDb().prepare(`
    SELECT COUNT(*) AS n
    FROM compliance_messages cm
    LEFT JOIN compliance_reviews cr ON cr.message_id = cm.message_id
    ${where}
  `).get(...params) as { n: number };

  return {
    messages: rows.map(deserializeMessageWithReview),
    total:    countRow.n,
  };
}

export function sampleMessagesForReview(count = 20): ComplianceMessage[] {
  for (const windowMs of [86_400_000, 172_800_000, 604_800_000]) {
    const rows = getDb().prepare(`
      SELECT * FROM compliance_messages
      WHERE created_at > ?
      ORDER BY RANDOM()
      LIMIT ?
    `).all(Date.now() - windowMs, count) as ComplianceMessage[];
    if (rows.length > 0) return rows;
  }
  return [];
}

export function getComplianceStats(): ComplianceUserStats[] {
  return (getDb().prepare(`
    SELECT
      cm.user_id,
      cm.display_name,
      COUNT(cm.id)                          AS total_messages,
      COUNT(cr.id)                          AS reviewed_count,
      SUM(CASE WHEN cr.flagged = 1 THEN 1 ELSE 0 END) AS flagged_count,
      AVG(cr.helpfulness_score)             AS avg_helpfulness,
      AVG(cr.tone_score)                    AS avg_tone
    FROM compliance_messages cm
    LEFT JOIN compliance_reviews cr ON cr.message_id = cm.message_id
    GROUP BY cm.user_id
    ORDER BY cm.user_id
  `).all() as Array<{
    user_id: string;
    display_name: string;
    total_messages: number;
    reviewed_count: number;
    flagged_count: number;
    avg_helpfulness: number | null;
    avg_tone: number | null;
  }>).map(row => ({
    user_id:         row.user_id,
    display_name:    row.display_name,
    total_messages:  row.total_messages,
    reviewed_count:  row.reviewed_count,
    flagged_count:   row.flagged_count ?? 0,
    avg_helpfulness: row.avg_helpfulness,
    avg_tone:        row.avg_tone,
  }));
}

// ── Watched users ─────────────────────────────────────────────────────────────

export function getWatchedUserIds(): string[] {
  try {
    return JSON.parse(getSetting('compliance_watched_users', '[]')) as string[];
  } catch {
    return [];
  }
}

export function setWatchedUserIds(ids: string[]): void {
  setSetting('compliance_watched_users', JSON.stringify(ids));
}
