import crypto from 'node:crypto';
import { getDb } from './db';

export interface AccessToken {
  id:         number;
  label:      string;
  token:      string;
  created_at: string;
  expires_at: string | null;
}

export type TokenSummary = Omit<AccessToken, 'token'>;

export function listTokens(): TokenSummary[] {
  return getDb()
    .prepare('SELECT id, label, created_at, expires_at FROM access_tokens ORDER BY created_at DESC')
    .all() as TokenSummary[];
}

export function createToken(label: string, expiresAt?: string): AccessToken {
  const token = crypto.randomBytes(32).toString('hex');
  const now   = new Date().toISOString();
  const result = getDb()
    .prepare('INSERT INTO access_tokens (label, token, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(label, token, now, expiresAt ?? null);
  return { id: Number(result.lastInsertRowid), label, token, created_at: now, expires_at: expiresAt ?? null };
}

export function revokeToken(id: number): boolean {
  const result = getDb()
    .prepare('DELETE FROM access_tokens WHERE id = ?')
    .run(id);
  return result.changes > 0;
}

export function verifyToken(token: string): boolean {
  const row = getDb()
    .prepare('SELECT expires_at FROM access_tokens WHERE token = ?')
    .get(token) as { expires_at: string | null } | undefined;
  if (!row) return false;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return false;
  return true;
}
