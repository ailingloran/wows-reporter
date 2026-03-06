import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { logger } from '../logger';
import { countIndexedMessages, queryIndexedMessages } from '../store/messageDb';

// Minimum messages in the index before we trust it over the Discord API
const MIN_INDEX_MESSAGES = 500;

const STOP_WORDS = new Set([
  'what', 'how', 'when', 'where', 'why', 'who', 'which', 'are', 'is',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'been',
  'they', 'their', 'about', 'would', 'could', 'should', 'were', 'will',
  'can', 'did', 'does', 'into', 'your', 'you', 'our', 'more', 'like',
  'than', 'think', 'players', 'player', 'say', 'says', 'said', 'feel',
  'feels', 'tell', 'give', 'make', 'take', 'want', 'need', 'there',
  'some', 'other', 'most', 'much', 'many', 'very', 'just', 'also',
  'only', 'but', 'not', 'all', 'any', 'its', 'it', 'be', 'has', 'do',
  'an', 'we', 'in', 'on', 'to', 'of', 'at', 'by',
]);

function extractKeywords(question: string): string[] {
  return [...new Set(
    question
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w)),
  )];
}
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

export function createChatJob(question: string, windowHours: number, collectCap: number): ChatJobResponse {
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

  insertChatJob(job);
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

  try {
    if (!config.sentimentChannelIds.length) {
      failChatJob(jobId, 'SENTIMENT_CHANNEL_IDS not configured');
      return;
    }

    updateChatJobStatus(jobId, 'running');
    logger.info(`[chat-job] Started ${jobId} (${job.window_hours}h, cap ${job.collect_cap})`);

    const { answerQuestion } = await import('../api/openai');

    const keywords     = extractKeywords(job.question);
    const indexedCount = countIndexedMessages(job.window_hours);
    const useIndex     = indexedCount >= MIN_INDEX_MESSAGES;

    let messages: string[];

    if (useIndex) {
      messages = queryIndexedMessages(
        job.window_hours,
        config.sentimentChannelIds,
        job.collect_cap,
        keywords,
      );
      logger.info(
        `[chat-job] Using index (${indexedCount} msgs in window). Keywords: [${keywords.join(', ')}]. Returning ${messages.length}`,
      );
    } else {
      logger.info(
        `[chat-job] Index has only ${indexedCount} msgs in ${job.window_hours}h window — falling back to Discord API`,
      );
      const { collectMessagesForWindow } = await import('../collectors/messageCollector');
      messages = await collectMessagesForWindow(
        config.sentimentChannelIds,
        job.window_hours,
        job.collect_cap,
      );
    }

    if (messages.length < 5) {
      completeChatJob(jobId, 'Not enough messages found in that time window to answer meaningfully.', messages.length, 0);
      logger.info(`[chat-job] Completed ${jobId} with insufficient message sample (${messages.length})`);
      return;
    }

    const result = await answerQuestion(messages, job.question);
    if ('error' in result) {
      failChatJob(jobId, result.error);
      return;
    }

    completeChatJob(jobId, result.answer, result.collected, result.analysed);
    logger.info(`[chat-job] Completed ${jobId}. Collected: ${result.collected}, analysed: ${result.analysed}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    failChatJob(jobId, message);
    logger.error(`[chat-job] Failed ${jobId}:`, error);
  }
}
