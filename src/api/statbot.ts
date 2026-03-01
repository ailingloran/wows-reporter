/**
 * Statbot REST API wrapper.
 * All calls use Bearer auth. Returns null on 404/plan-unavailable endpoints
 * so the report builder can degrade gracefully.
 */

import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../logger';

const BASE_URL = 'https://api.statbot.net/v1';

const client: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  headers: { Authorization: `Bearer ${config.statbotApiKey}` },
  timeout: 15_000,
});

// ── Helper ───────────────────────────────────────────────────────────────────

function toIso(d: Date): string {
  return d.toISOString();
}

async function safeGet<T>(url: string, params: Record<string, string>): Promise<T | null> {
  try {
    const { data } = await client.get<T>(url, { params });
    return data;
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 404 || status === 403) {
      logger.warn(`[statbot] Endpoint unavailable (${status}): ${url}`);
      return null;
    }
    logger.error(`[statbot] Request failed for ${url}:`, err?.message);
    throw err;
  }
}

// ── Exported API Functions ───────────────────────────────────────────────────

const GID = config.statbotGuildId;

/** Total messages in the given time window. */
export async function getMessages(from: Date, to: Date): Promise<{ count: number } | null> {
  return safeGet(`/guilds/${GID}/messages`, {
    from: toIso(from),
    to:   toIso(to),
  });
}

/** Unique active members in the given time window. */
export async function getActiveMembers(from: Date, to: Date): Promise<{ count: number } | null> {
  return safeGet(`/guilds/${GID}/members/active`, {
    from: toIso(from),
    to:   toIso(to),
  });
}

/** Number of members who joined in the given window. */
export async function getJoins(from: Date, to: Date): Promise<{ count: number } | null> {
  return safeGet(`/guilds/${GID}/members/joins`, {
    from: toIso(from),
    to:   toIso(to),
  });
}

/** Number of members who left in the given window. */
export async function getLeaves(from: Date, to: Date): Promise<{ count: number } | null> {
  return safeGet(`/guilds/${GID}/members/leaves`, {
    from: toIso(from),
    to:   toIso(to),
  });
}

export interface ChannelStat {
  channelId:    string;
  name:         string;
  messageCount: number;
}

/** Per-channel message breakdown for the given window. */
export async function getChannelStats(from: Date, to: Date): Promise<ChannelStat[] | null> {
  return safeGet(`/guilds/${GID}/channels`, {
    from: toIso(from),
    to:   toIso(to),
  });
}

export interface ThreadStat {
  threadId:     string;
  name:         string;
  messageCount: number;
}

/** Per-thread message breakdown (may return null if not on your plan). */
export async function getThreadStats(from: Date, to: Date): Promise<ThreadStat[] | null> {
  return safeGet(`/guilds/${GID}/threads`, {
    from: toIso(from),
    to:   toIso(to),
  });
}

export interface KeywordResult {
  keyword: string;
  count:   number;
}

/** Keyword frequency data (may return null if not on your plan). */
export async function getKeywords(from: Date, to: Date): Promise<KeywordResult[] | null> {
  return safeGet(`/guilds/${GID}/keywords`, {
    from: toIso(from),
    to:   toIso(to),
  });
}
