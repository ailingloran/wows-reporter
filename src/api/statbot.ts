/**
 * Statbot REST API wrapper — updated to match current API (v1).
 * All time params use Unix timestamps in milliseconds (not ISO strings).
 * Returns null on 404/403 so the report builder can degrade gracefully.
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

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a Date to Unix timestamp in milliseconds (what Statbot expects). */
function toMs(d: Date): number {
  return d.getTime();
}

async function safeGet<T>(url: string, params: Record<string, any>): Promise<T | null> {
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

// ── Internal types ────────────────────────────────────────────────────────────

interface MemberCountPoint {
  unixTimestamp: number;
  count:         number;
  joins:         number;
  leaves:        number;
}

// ── Exported API Functions ───────────────────────────────────────────────────

const GID = config.statbotGuildId;

/** Total messages in the given time window. */
export async function getMessages(from: Date, to: Date): Promise<{ count: number } | null> {
  return safeGet(`/guilds/${GID}/messages/sums`, {
    start: toMs(from),
    end:   toMs(to),
  });
}

/**
 * Unique active members in the given time window.
 * Uses /counts/members which returns one entry per active member — we count the array length.
 */
export async function getActiveMembers(from: Date, to: Date): Promise<{ count: number } | null> {
  const data = await safeGet<any[]>(`/guilds/${GID}/counts/members`, {
    start: toMs(from),
    end:   toMs(to),
  });
  if (data === null) return null;
  return { count: data.length };
}

/**
 * Fetch member count series which contains joins + leaves per day.
 * Both getJoins and getLeaves share this endpoint.
 */
async function getMemberCountSeries(from: Date, to: Date): Promise<MemberCountPoint[] | null> {
  return safeGet<MemberCountPoint[]>(`/guilds/${GID}/membercounts/series`, {
    start:    toMs(from),
    end:      toMs(to),
    interval: 'day',
  });
}

/** Number of members who joined in the given window. */
export async function getJoins(from: Date, to: Date): Promise<{ count: number } | null> {
  const series = await getMemberCountSeries(from, to);
  if (series === null) return null;
  return { count: series.reduce((sum, p) => sum + (p.joins ?? 0), 0) };
}

/** Number of members who left in the given window. */
export async function getLeaves(from: Date, to: Date): Promise<{ count: number } | null> {
  const series = await getMemberCountSeries(from, to);
  if (series === null) return null;
  return { count: series.reduce((sum, p) => sum + (p.leaves ?? 0), 0) };
}

export interface ChannelStat {
  channelId:    string;
  name:         string;
  messageCount: number;
}

/**
 * Top channels by message count for the given window.
 * Uses /messages/tops/channels with full=true to get channel id + name.
 */
export async function getChannelStats(from: Date, to: Date): Promise<ChannelStat[] | null> {
  const data = await safeGet<any[]>(`/guilds/${GID}/messages/tops/channels`, {
    start: toMs(from),
    end:   toMs(to),
    full:  true,
    limit: 10,
  });
  if (data === null) return null;
  return data.map(ch => ({
    channelId:    String(ch.id ?? ch.channelId ?? ch.rank),
    name:         ch.name ?? ch.channelName ?? `Channel #${ch.rank}`,
    messageCount: ch.count ?? ch.messageCount ?? 0,
  }));
}

export interface ThreadStat {
  threadId:     string;
  name:         string;
  messageCount: number;
}

/** Thread stats — not available in current Statbot API, skipped gracefully. */
export async function getThreadStats(_from: Date, _to: Date): Promise<ThreadStat[] | null> {
  return null;
}

export interface KeywordResult {
  keyword: string;
  count:   number;
}

/** Keyword data — not available in current Statbot API, skipped gracefully. */
export async function getKeywords(_from: Date, _to: Date): Promise<KeywordResult[] | null> {
  return null;
}
