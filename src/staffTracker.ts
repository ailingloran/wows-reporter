/**
 * Staff Activity Tracker
 *
 * Listens to ALL messageCreate events across the entire server (not just indexed
 * channels) and logs messages from tracked staff members to staff_message_events.
 *
 * Tracked members are identified by:
 *   1. Explicit user ID in staff_tracked_users (highest priority)
 *   2. Having a role listed in staff_tracked_roles
 *
 * Config is cached and refreshed every 5 minutes to avoid hitting the DB on
 * every single message.
 */

import { Message } from 'discord.js';
import { getDiscordClient } from './api/discord';
import { logger } from './logger';
import {
  getTrackedRoleMap,
  getTrackedUserMap,
  logStaffMessage,
} from './store/staffDb';
import { getWatchedUserIds, insertComplianceMessage } from './store/complianceDb';

const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

let trackedUserMap = new Map<string, number>();
let trackedRoleMap = new Map<string, number>();
let watchedComplianceIds = new Set<string>();
let lastRefresh = 0;

function refreshCache(): void {
  trackedUserMap = getTrackedUserMap();
  trackedRoleMap = getTrackedRoleMap();
  watchedComplianceIds = new Set(getWatchedUserIds());
  lastRefresh = Date.now();
}

/** Call this after adding/removing roles or users to invalidate the cache immediately. */
export function invalidateStaffCache(): void {
  lastRefresh = 0;
}

export function startStaffTracker(): void {
  const client = getDiscordClient();
  refreshCache();

  client.on('messageCreate', (message: Message) => {
    if (message.author.bot) return;
    if (!message.guild || !message.member) return;

    // Refresh cache if stale
    if (Date.now() - lastRefresh > CACHE_TTL_MS) refreshCache();

    // Resolve group: explicit user assignment takes priority over role
    let groupId = trackedUserMap.get(message.author.id);

    if (groupId === undefined) {
      for (const [roleId, gId] of trackedRoleMap) {
        if (message.member.roles.cache.has(roleId)) {
          groupId = gId;
          break;
        }
      }
    }

    if (groupId === undefined) return; // not a tracked staff member

    const isThread = message.channel.isThread();
    let channelId: string;
    let channelName: string;
    let threadId: string | null = null;

    if (isThread) {
      channelId = message.channel.parentId ?? message.channelId;
      // Try to resolve parent channel name from cache
      const parent = client.channels.cache.get(channelId);
      channelName = (parent && 'name' in parent && parent.name) ? parent.name : channelId;
      threadId = message.channelId;
    } else {
      channelId = message.channelId;
      channelName = ('name' in message.channel && message.channel.name) ? message.channel.name : message.channelId;
    }

    logStaffMessage({
      user_id:      message.author.id,
      display_name: message.member.displayName,
      group_id:     groupId,
      channel_id:   channelId,
      channel_name: channelName,
      is_thread:    isThread ? 1 : 0,
      thread_id:    threadId,
      message_id:   message.id,
      created_at:   message.createdTimestamp,
    });

    // Capture message content for compliance monitoring if user is watched
    if (watchedComplianceIds.has(message.author.id) && message.content.trim()) {
      insertComplianceMessage({
        message_id:   message.id,
        user_id:      message.author.id,
        display_name: message.member.displayName,
        channel_id:   channelId,
        channel_name: channelName,
        content:      message.content,
        created_at:   message.createdTimestamp,
      });
    }
  });

  logger.info('[staffTracker] Staff activity tracker active');
}
