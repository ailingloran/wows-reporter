/**
 * @Player Role Tracker
 * Tracks additions/removals of the @Player role in real-time via Discord Gateway events,
 * and takes a nightly count snapshot for trend reporting.
 */

import { GuildMember, PartialGuildMember, Guild } from 'discord.js';
import { config } from '../config';
import { logger } from '../logger';
import {
  insertPlayerRoleEvent,
  upsertPlayerRoleSnapshot,
  getLatestPlayerRoleSnapshot,
} from '../store/db';

// ── Real-time event listener ──────────────────────────────────────────────────

/**
 * Called on every guildMemberUpdate event.
 * Writes a join/leave record to player_role_events when the @Player role changes.
 */
export function handleMemberUpdate(
  oldMember: GuildMember | PartialGuildMember,
  newMember: GuildMember | PartialGuildMember,
): void {
  const roleId  = config.discordPlayerRoleId;
  const hadRole = oldMember.roles.cache.has(roleId);
  const hasRole = newMember.roles.cache.has(roleId);

  if (!hadRole && hasRole) {
    insertPlayerRoleEvent(newMember.id, 'join');
    logger.debug(`[memberTracker] @Player role ADDED  → ${newMember.id}`);
  } else if (hadRole && !hasRole) {
    insertPlayerRoleEvent(newMember.id, 'leave');
    logger.debug(`[memberTracker] @Player role REMOVED → ${newMember.id}`);
  }
}

// ── Nightly snapshot ──────────────────────────────────────────────────────────

/**
 * Count all members currently holding the @Player role and save to DB.
 * Called by the scheduler at 00:05 CET every day (just after the daily report).
 */
export async function snapshotPlayerRole(guild: Guild): Promise<number> {
  // Fetch all members to populate cache (required for large servers)
  await guild.members.fetch();

  const roleId = config.discordPlayerRoleId;
  const count  = guild.members.cache.filter(m => m.roles.cache.has(roleId)).size;
  const date   = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD

  upsertPlayerRoleSnapshot(date, count);
  logger.info(`[memberTracker] Snapshot saved: ${count} @Player members on ${date}`);
  return count;
}

// ── Seed / baseline ───────────────────────────────────────────────────────────

/**
 * On first run (--seed flag), write an initial baseline snapshot so deltas
 * can be computed from day 1.
 */
export async function seedPlayerRoleBaseline(guild: Guild): Promise<void> {
  const existing = getLatestPlayerRoleSnapshot();
  if (existing) {
    logger.info(`[memberTracker] Baseline already exists (${existing.snapshot_date}: ${existing.total_count}). Skipping seed.`);
    return;
  }

  const count = await snapshotPlayerRole(guild);
  logger.info(`[memberTracker] Baseline seeded: ${count} @Player members.`);
}
