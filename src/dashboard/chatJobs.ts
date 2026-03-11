import { randomUUID } from 'node:crypto';
import {
  ChatJobRow,
  completeChatJob,
  countChatJobs,
  deleteChatJob,
  failChatJob,
  getChatJob,
  insertChatJob,
  listChatJobs,
  updateChatJobStatus,
} from '../store/db';
import { config } from '../config';
import { logger } from '../logger';
import { countIndexedMessages, searchMessagesFts } from '../store/messageDb';
import { getSetting } from '../store/settingsDb';
import { SessionTurn } from '../api/openai';

// ── Session management ────────────────────────────────────────────────────────

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours of inactivity

interface SessionData {
  turns:  SessionTurn[];
  expiry: number;
}

const sessionHistory = new Map<string, SessionData>();

function getSessionTurns(sessionId: string): SessionTurn[] {
  const session = sessionHistory.get(sessionId);
  if (!session || session.expiry < Date.now()) {
    sessionHistory.delete(sessionId);
    return [];
  }
  // Refresh TTL on access
  session.expiry = Date.now() + SESSION_TTL_MS;
  return [...session.turns];
}

function appendSessionTurn(sessionId: string, turn: SessionTurn): void {
  const session = sessionHistory.get(sessionId) ?? { turns: [], expiry: 0 };
  session.turns.push(turn);
  // Cap at last 5 turns to avoid context explosion
  if (session.turns.length > 5) session.turns = session.turns.slice(-5);
  session.expiry = Date.now() + SESSION_TTL_MS;
  sessionHistory.set(sessionId, session);
}

// ── Per-job metadata (session context + channel filter, held in memory) ───────

interface JobMeta {
  sessionId?:  string;
  channelIds?: string[];
  priorTurns:  SessionTurn[];
}

const jobMeta = new Map<string, JobMeta>();

// ── Public types ──────────────────────────────────────────────────────────────

const activeJobs = new Set<string>();

export interface ChatJobResponse {
  jobId: string;
  status: ChatJobRow['status'];
  answer?: string;
  collected?: number;
  analysed?: number;
  error?: string;
}

export interface ChatJobHistoryItem extends ChatJobResponse {
  createdAt: string;
  question: string;
}

export interface ChatJobHistoryPage {
  items: ChatJobHistoryItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

function toChatJobResponse(job: ChatJobRow): ChatJobResponse {
  return {
    jobId: job.id,
    status: job.status,
    ...(job.answer ? { answer: job.answer } : {}),
    ...(typeof job.collected === 'number' ? { collected: job.collected } : {}),
    ...(typeof job.analysed === 'number' ? { analysed: job.analysed } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

export function createChatJob(
  question:    string,
  windowHours: number,
  collectCap:  number,
  sessionId?:  string,
  channelIds?: string[],
): ChatJobResponse {
  const now = new Date().toISOString();
  const job: ChatJobRow = {
    id: randomUUID(),
    created_at: now,
    updated_at: now,
    question,
    window_hours: windowHours,
    collect_cap: collectCap,
    status: 'queued',
    answer: null,
    collected: null,
    analysed: null,
    error: null,
  };

  // Snapshot session turns at job creation time
  const priorTurns = sessionId ? getSessionTurns(sessionId) : [];

  insertChatJob(job);
  jobMeta.set(job.id, { sessionId, channelIds, priorTurns });
  queueChatJob(job.id);
  return toChatJobResponse(job);
}

export function getChatJobResponse(jobId: string): ChatJobResponse | null {
  const job = getChatJob(jobId);
  return job ? toChatJobResponse(job) : null;
}

export function getChatHistoryPage(page: number, pageSize: number): ChatJobHistoryPage {
  const total = countChatJobs();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const offset = (safePage - 1) * pageSize;
  const items = listChatJobs(pageSize, offset).map((job) => ({
    ...toChatJobResponse(job),
    createdAt: job.created_at,
    question: job.question,
  }));

  return {
    items,
    page: safePage,
    pageSize,
    total,
    totalPages,
  };
}

export function removeChatJob(jobId: string): boolean {
  if (activeJobs.has(jobId)) {
    return false;
  }
  return deleteChatJob(jobId);
}

export function queueChatJob(jobId: string): void {
  if (activeJobs.has(jobId)) return;
  activeJobs.add(jobId);

  setImmediate(() => {
    void runChatJob(jobId).finally(() => {
      activeJobs.delete(jobId);
    });
  });
}

async function runChatJob(jobId: string): Promise<void> {
  const job = getChatJob(jobId);
  if (!job) return;

  const meta = jobMeta.get(jobId);

  // Resolve channel IDs: use per-job filter if provided, else all configured channels
  const configuredChannels = getSetting('sentiment_channel_ids', config.sentimentChannelIds.join(','))
    .split(',').map(s => s.trim()).filter(Boolean);
  const channelIds = meta?.channelIds?.length ? meta.channelIds : configuredChannels;
  const priorTurns = meta?.priorTurns ?? [];

  try {
    if (!configuredChannels.length) {
      failChatJob(jobId, 'SENTIMENT_CHANNEL_IDS not configured');
      return;
    }

    updateChatJobStatus(jobId, 'running');
    const windowLabel = job.window_hours ? `${job.window_hours}h` : 'all time';
    logger.info(`[chat-job] Started ${jobId} (window: ${windowLabel}, cap: ${job.collect_cap}, channels: ${channelIds.length})`);

    const { answerQuestion, extractKeywordsForSearch } = await import('../api/openai');

    // ── Pass 1: extract FTS5 search keywords from the question via GPT ──────
    const ftsQuery     = await extractKeywordsForSearch(job.question);
    const minIndex     = parseInt(getSetting('min_index_messages', '500'), 10);
    const indexedCount = countIndexedMessages(job.window_hours || undefined);
    const useIndex     = indexedCount >= minIndex;

    let messages: string[];

    if (useIndex) {
      // ── Pass 2: FTS5 BM25 search — most relevant messages ranked first ────
      messages = searchMessagesFts(
        ftsQuery,
        job.window_hours,
        channelIds,
        job.collect_cap,
      );
      logger.info(
        `[chat-job] FTS search (${indexedCount} indexed). Query: "${ftsQuery}". Retrieved: ${messages.length}`,
      );
    } else {
      // Fall back to live Discord API collection when the index is sparse
      const apiWindowHours = job.window_hours || 24;
      logger.info(
        `[chat-job] Index has only ${indexedCount} msgs — falling back to Discord API (${apiWindowHours}h)`,
      );
      const { collectMessagesForWindow } = await import('../collectors/messageCollector');
      messages = await collectMessagesForWindow(
        channelIds,
        apiWindowHours,
        job.collect_cap,
      );
    }

    if (messages.length < 5) {
      completeChatJob(jobId, 'Not enough messages found in that time window to answer meaningfully.', messages.length, 0);
      logger.info(`[chat-job] Completed ${jobId} with insufficient message sample (${messages.length})`);
      return;
    }

    const result = await answerQuestion(messages, job.question, priorTurns);
    if ('error' in result) {
      failChatJob(jobId, result.error);
      return;
    }

    completeChatJob(jobId, result.answer, result.collected, result.analysed);
    logger.info(`[chat-job] Completed ${jobId}. Collected: ${result.collected}, analysed: ${result.analysed}`);

    // Append to session history after successful completion
    if (meta?.sessionId) {
      appendSessionTurn(meta.sessionId, { question: job.question, answer: result.answer });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    failChatJob(jobId, message);
    logger.error(`[chat-job] Failed ${jobId}:`, error);
  } finally {
    jobMeta.delete(jobId);
  }
}
