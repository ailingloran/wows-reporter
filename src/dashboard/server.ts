/**
 * Express web dashboard + internal REST API.
 * Supports Basic Auth (browser) and Bearer token (Next.js dashboard calls).
 * Reads directly from SQLite; trigger endpoints fire bot report jobs.
 */

import express, { NextFunction, Request, Response } from 'express';
import path from 'path';
import { config } from '../config';
import { logger } from '../logger';
import {
  getChannelStatsForSnapshot,
  getDb,
  getLastSentimentReport,
  getLastSnapshot,
  getSentimentReports,
  getSentimentReportTrend,
  getSnapshotsBetween,
  getWeeklyPulseReports,
} from '../store/db';
import { getSetting } from '../store/settingsDb';
import { countIndexedMessages, getFtsHealth, rebuildFts } from '../store/messageDb';
import { getAllSettings, setSetting } from '../store/settingsDb';
import { rescheduleReport } from '../scheduler';
import { createChatJob, getChatHistoryPage, getChatJobResponse, removeChatJob } from './chatJobs';
import {
  addRoleToGroup, addUserToGroup,
  getStaffActivity, getStaffGroupConfig,
  getWeeklySnapshots,
  removeRoleFromGroup, removeUserFromGroup,
  takeWeeklySnapshot,
} from '../store/staffDb';
import { invalidateStaffCache } from '../staffTracker';
import { createToken, listTokens, revokeToken, verifyToken } from '../store/tokenDb';
import {
  getCategoryTrend,
  getEmergingKeywords,
  getNarrativeDrift,
  getNarrativeHeatmap,
  reprocessNarrativeHistory,
  getAiSuggestedImprovements,
} from '../store/narrativeDb';

// ── AI Narrative Drift (optional — gated by NARRATIVE_AI_ENABLED) ─────────────
import {
  getCategoryTrendAI,
  getEmergingKeywordsAI,
  getNarrativeDriftAI,
  getNarrativeHeatmapAI,
  reprocessNarrativeHistoryAI,
} from '../store/narrativeAiDb';

const app = express();
app.use(express.json());

// Simple in-memory rate limiter for expensive AI endpoints (max 10/min globally)
const chatTimestamps: number[] = [];
function chatRateLimitOk(): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  while (chatTimestamps.length > 0 && chatTimestamps[0] < cutoff) chatTimestamps.shift();
  if (chatTimestamps.length >= 10) return false;
  chatTimestamps.push(now);
  return true;
}

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin ?? '';
  if (origin.startsWith('http://localhost') || origin === 'https://dockworks.dev') {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use((req: Request, res: Response, next: NextFunction) => {
  const auth = req.headers.authorization ?? '';

  if (auth.startsWith('Bearer ')) {
    if (auth.slice(7) === config.dashboardSecret) return next();
  }

  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf-8');
    const password = decoded.split(':')[1];
    if (password === config.dashboardSecret) return next();
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="WoWS Reporter Dashboard"');
  res.status(401).json({ error: 'Unauthorized' });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (_req: Request, res: Response) => {
  try {
    const lastDaily     = getLastSnapshot('daily');
    const lastSentiment = getLastSentimentReport();
    const lastWeekly    = getWeeklyPulseReports(1)[0] ?? null;
    res.json({
      uptime:           process.uptime(),
      lastDailyAt:      lastDaily?.taken_at      ?? null,
      lastSentimentAt:  lastSentiment?.taken_at  ?? null,
      lastMood:         lastSentiment?.mood       ?? null,
      lastWeeklyPulseAt: lastWeekly?.taken_at    ?? null,
      totalMessages:    countIndexedMessages(),
    });
  } catch (error) {
    logger.error('[dashboard] /api/status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/daily', (req: Request, res: Response) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt((req.query.days as string) || '365', 10)));
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    const rows = getSnapshotsBetween('daily', from.toISOString(), to.toISOString());
    res.json(rows);
  } catch (error) {
    logger.error('[dashboard] /api/daily error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/weekly-pulse', (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    res.json(getWeeklyPulseReports(limit));
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/players', (_req: Request, res: Response) => {
  try {
    const rows = getDb()
      .prepare(`SELECT * FROM player_role_snapshots ORDER BY snapshot_date ASC`)
      .all();
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/channels', (_req: Request, res: Response) => {
  try {
    const latest = getDb()
      .prepare(`SELECT id FROM snapshots WHERE period = 'daily' ORDER BY taken_at DESC LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!latest) {
      res.json([]);
      return;
    }
    res.json(getChannelStatsForSnapshot(latest.id));
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/sentiment', (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    res.json(getSentimentReports(limit));
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/sentiment/trend', (req: Request, res: Response) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    res.json(getSentimentReportTrend(days));
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Returns configured sentiment channel IDs with names resolved from Discord
app.get('/api/sentiment/channels', (_req: Request, res: Response) => {
  void (async () => {
    try {
      const ids = getSetting('sentiment_channel_ids', config.sentimentChannelIds.join(','))
        .split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length === 0) { res.json([]); return; }

      const { getDiscordClient } = await import('../api/discord');
      const client = getDiscordClient();
      const channels = await Promise.all(ids.map(async id => {
        try {
          const ch = await client.channels.fetch(id);
          return { id, name: ch && 'name' in ch && ch.name ? `#${ch.name}` : id };
        } catch {
          return { id, name: id };
        }
      }));
      res.json(channels);
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  })();
});

app.get('/api/chat', (req: Request, res: Response) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 20, 1), 100);
  res.json(getChatHistoryPage(page, pageSize));
});

app.post('/api/chat', (req: Request, res: Response) => {
  if (!chatRateLimitOk()) {
    res.status(429).json({ error: 'Too many chat requests — wait a moment and try again' });
    return;
  }
  const { question, windowHours = 0, collectCap = 3000, sessionId, channelIds } = req.body as {
    question:    string;
    windowHours: number;
    collectCap:  number;
    sessionId?:  string;
    channelIds?: string[];
  };

  if (!question?.trim()) {
    res.status(400).json({ error: 'question is required' });
    return;
  }

  const configuredChannels = getSetting('sentiment_channel_ids', config.sentimentChannelIds.join(','))
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!configuredChannels.length) {
    res.status(400).json({ error: 'SENTIMENT_CHANNEL_IDS not configured' });
    return;
  }

  // windowHours = 0 means "all time" (no cutoff); clamp to [0, 720]
  const cappedHours = Math.min(Math.max(Number(windowHours), 0), 720);
  const cappedCap   = Math.min(Math.max(Number(collectCap) || 3000, 50), 10_000);

  // Validate requested channel IDs are a subset of configured ones
  const validChannelIds = Array.isArray(channelIds)
    ? channelIds.filter(id => configuredChannels.includes(id))
    : undefined;

  const windowLabel = cappedHours ? `${cappedHours}h` : 'all time';
  logger.info(
    `[dashboard] Chat queued - window: ${windowLabel}, cap: ${cappedCap}` +
    `${sessionId ? `, session: ${sessionId.slice(0, 8)}` : ''}` +
    `${validChannelIds?.length ? `, channels: ${validChannelIds.length}` : ''}` +
    `, q: "${question}"`,
  );
  const job = createChatJob(question.trim(), cappedHours, cappedCap, sessionId, validChannelIds);
  res.status(202).json(job);
});

app.get('/api/chat/:jobId', (req: Request, res: Response) => {
  const job = getChatJobResponse(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Chat job not found' });
    return;
  }
  res.json(job);
});

app.delete('/api/chat/:jobId', (req: Request, res: Response) => {
  const job = getChatJobResponse(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Chat job not found' });
    return;
  }

  const removed = removeChatJob(req.params.jobId);
  if (!removed) {
    res.status(409).json({ error: 'Chat job is still running and cannot be deleted yet' });
    return;
  }

  res.json({ ok: true });
});

app.post('/api/trigger/daily', (_req: Request, res: Response) => {
  Promise.all([
    import('../reports/daily'),
    import('../collectors/memberTracker'),
  ]).then(async ([{ runDailyReport }, { snapshotPlayerRole }]) => {
    const client = (await import('../api/discord')).getDiscordClient();
    const { config: cfg } = await import('../config');
    const guild = await client.guilds.fetch(cfg.statbotGuildId);
    snapshotPlayerRole(guild)
      .then(() => runDailyReport())
      .catch((error: unknown) => logger.error('[dashboard] Triggered daily report failed:', error));
    res.json({ ok: true, message: 'Daily report triggered' });
  }).catch(() => res.status(500).json({ error: 'Failed to load report module' }));
});

app.post('/api/trigger/sentiment', (_req: Request, res: Response) => {
  import('../reports/sentiment').then(({ runSentimentReport }) => {
    runSentimentReport('db').catch((error: unknown) => logger.error('[dashboard] Triggered sentiment report failed:', error));
    res.json({ ok: true, message: 'Sentiment report triggered (DB source)' });
  }).catch(() => res.status(500).json({ error: 'Failed to load report module' }));
});

app.post('/api/trigger/sentiment/live', (_req: Request, res: Response) => {
  import('../reports/sentiment').then(({ runSentimentReport }) => {
    runSentimentReport('live').catch((error: unknown) => logger.error('[dashboard] Triggered live sentiment report failed:', error));
    res.json({ ok: true, message: 'Sentiment report triggered (live Discord scrape)' });
  }).catch(() => res.status(500).json({ error: 'Failed to load report module' }));
});

// Weekly Pulse Summary — awaits completion so the dashboard button can show true success/failure
app.post('/api/trigger/weekly-pulse', (_req: Request, res: Response) => {
  void (async () => {
    try {
      const { runWeeklyPulseSummary } = await import('../reports/weeklyPulse');
      await runWeeklyPulseSummary();
      res.json({ ok: true, message: 'Weekly Pulse Summary generated' });
    } catch (err) {
      logger.error('[dashboard] Triggered weekly pulse failed:', err);
      res.status(500).json({ error: 'Weekly Pulse Summary failed' });
    }
  })();
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Settings ──────────────────────────────────────────────────────────────────

app.get('/api/settings', (_req: Request, res: Response) => {
  try {
    res.json(getAllSettings());
  } catch (error) {
    logger.error('[dashboard] /api/settings GET error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/settings', (req: Request, res: Response) => {
  try {
    const updates = req.body as Record<string, string>;
    const hourFields: Array<[string, 'daily' | 'sentiment']> = [
      ['daily_hour', 'daily'],
      ['sentiment_hour', 'sentiment'],
    ];

    for (const [key, value] of Object.entries(updates)) {
      setSetting(key, String(value));
    }

    // Hot-reload cron if an hour changed
    for (const [key, type] of hourFields) {
      if (key in updates) {
        const hour = parseInt(String(updates[key]), 10);
        if (!isNaN(hour)) rescheduleReport(type, hour);
      }
    }

    // Hot-reload indexer channel list if channels changed
    if ('sentiment_channel_ids' in updates) {
      const ids = String(updates['sentiment_channel_ids'])
        .split(',').map(s => s.trim()).filter(Boolean);
      import('../indexer/messageIndexer')
        .then(({ refreshChannels }) => refreshChannels(ids))
        .catch(() => {/* indexer not started in test/backfill modes */});
    }

    res.json({ ok: true });
  } catch (error) {
    logger.error('[dashboard] /api/settings POST error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Index health + maintenance ────────────────────────────────────────────────

app.get('/api/index/health', (_req: Request, res: Response) => {
  try {
    res.json(getFtsHealth());
  } catch (error) {
    logger.error('[dashboard] /api/index/health error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/index/rebuild', (_req: Request, res: Response) => {
  try {
    rebuildFts();
    logger.info('[dashboard] FTS index rebuilt via dashboard');
    res.json({ ok: true, message: 'FTS index rebuilt' });
  } catch (error) {
    logger.error('[dashboard] /api/index/rebuild error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/backfill', (req: Request, res: Response) => {
  const hours = Math.min(Math.max(parseInt((req.body as { hours?: string }).hours ?? '48', 10), 1), 720);
  import('../indexer/messageIndexer').then(({ backfillMessages }) => {
    backfillMessages(hours).catch((err: unknown) => logger.error('[dashboard] Backfill failed:', err));
    res.json({ ok: true, message: `Backfill started for last ${hours}h` });
  }).catch(() => res.status(500).json({ error: 'Failed to load indexer module' }));
});

// ── Staff activity tracking ───────────────────────────────────────────────────

app.get('/api/staff/config', (_req: Request, res: Response) => {
  try {
    res.json(getStaffGroupConfig());
  } catch (error) {
    logger.error('[dashboard] /api/staff/config error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/staff/activity', (req: Request, res: Response) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 30);
    res.json(getStaffActivity(days));
  } catch (error) {
    logger.error('[dashboard] /api/staff/activity error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/staff/snapshots', (req: Request, res: Response) => {
  try {
    const weeks = Math.min(Math.max(Number(req.query.weeks) || 12, 1), 52);
    res.json(getWeeklySnapshots(weeks));
  } catch (error) {
    logger.error('[dashboard] /api/staff/snapshots error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/staff/snapshots/take', (_req: Request, res: Response) => {
  try {
    takeWeeklySnapshot();
    res.json({ ok: true });
  } catch (error) {
    logger.error('[dashboard] /api/staff/snapshots/take error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/staff/groups/:groupId/roles', (req: Request, res: Response) => {
  try {
    const groupId = parseInt(req.params.groupId, 10);
    const { roleId } = req.body as { roleId: string };
    if (!roleId?.trim()) { res.status(400).json({ error: 'roleId required' }); return; }
    addRoleToGroup(groupId, roleId.trim());
    invalidateStaffCache();
    res.json({ ok: true });
  } catch (error) {
    logger.error('[dashboard] POST /api/staff/groups/:id/roles error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/staff/groups/:groupId/roles/:roleId', (req: Request, res: Response) => {
  try {
    removeRoleFromGroup(parseInt(req.params.groupId, 10), req.params.roleId);
    invalidateStaffCache();
    res.json({ ok: true });
  } catch (error) {
    logger.error('[dashboard] DELETE /api/staff/groups/:id/roles/:roleId error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/staff/groups/:groupId/users', (req: Request, res: Response) => {
  try {
    const groupId = parseInt(req.params.groupId, 10);
    const { userId } = req.body as { userId: string };
    if (!userId?.trim()) { res.status(400).json({ error: 'userId required' }); return; }
    addUserToGroup(groupId, userId.trim());
    invalidateStaffCache();
    res.json({ ok: true });
  } catch (error) {
    logger.error('[dashboard] POST /api/staff/groups/:id/users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/staff/groups/:groupId/users/:userId', (req: Request, res: Response) => {
  try {
    removeUserFromGroup(parseInt(req.params.groupId, 10), req.params.userId);
    invalidateStaffCache();
    res.json({ ok: true });
  } catch (error) {
    logger.error('[dashboard] DELETE /api/staff/groups/:id/users/:userId error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Access tokens ─────────────────────────────────────────────────────────────

app.get('/api/tokens', (_req: Request, res: Response) => {
  try {
    res.json(listTokens());
  } catch (error) {
    logger.error('[dashboard] GET /api/tokens error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/tokens', (req: Request, res: Response) => {
  try {
    const { label, expiresAt } = req.body as { label?: string; expiresAt?: string };
    if (!label?.trim()) {
      res.status(400).json({ error: 'label is required' });
      return;
    }
    const token = createToken(label.trim(), expiresAt);
    res.json(token); // includes the plain-text token — shown once
  } catch (error) {
    logger.error('[dashboard] POST /api/tokens error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/tokens/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ok = revokeToken(id);
    res.json({ ok });
  } catch (error) {
    logger.error('[dashboard] DELETE /api/tokens/:id error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unauthenticated verify endpoint — used by the frontend login flow
app.post('/api/tokens/verify', (req: Request, res: Response) => {
  const auth = req.headers.authorization ?? '';
  // Allow this endpoint with just the dashboard secret (from frontend server-side)
  // or skip auth check — it only returns true/false, no sensitive data
  const { token } = req.body as { token?: string };
  if (!token) {
    res.status(400).json({ error: 'token is required' });
    return;
  }
  res.json({ valid: verifyToken(token) });
});

// ── Narrative drift tracking ───────────────────────────────────────────────────

app.get('/api/narrative/heatmap', (req: Request, res: Response) => {
  try {
    const weeks = Math.min(Math.max(Number(req.query.weeks) || 12, 4), 52);
    res.json(getNarrativeHeatmap(weeks));
  } catch (error) {
    logger.error('[dashboard] /api/narrative/heatmap error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/narrative/drift', (_req: Request, res: Response) => {
  try {
    res.json(getNarrativeDrift());
  } catch (error) {
    logger.error('[dashboard] /api/narrative/drift error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/narrative/trend', (req: Request, res: Response) => {
  try {
    const category = String(req.query.category ?? '');
    const days = Math.min(Math.max(Number(req.query.days) || 90, 7), 365);
    if (!category) { res.status(400).json({ error: 'category required' }); return; }
    res.json(getCategoryTrend(category, days));
  } catch (error) {
    logger.error('[dashboard] /api/narrative/trend error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/narrative/keywords', (req: Request, res: Response) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 14, 7), 90);
    res.json(getEmergingKeywords(days));
  } catch (error) {
    logger.error('[dashboard] /api/narrative/keywords error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/narrative/suggestions', (_req: Request, res: Response) => {
  try {
    res.json(getAiSuggestedImprovements());
  } catch (error) {
    logger.error('[dashboard] /api/narrative/suggestions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/narrative/reprocess', (_req: Request, res: Response) => {
  try {
    const result = reprocessNarrativeHistory();
    res.json({ ok: true, ...result });
  } catch (error) {
    logger.error('[dashboard] /api/narrative/reprocess error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── AI Narrative Drift routes (always registered; check narrative_ai_enabled per-request) ─

function aiNarrativeEnabled(): boolean {
  return getSetting('narrative_ai_enabled', 'false') === 'true';
}

app.get('/api/narrative-ai/heatmap', (req: Request, res: Response) => {
  if (!aiNarrativeEnabled()) { res.status(503).json({ error: 'AI Narrative Drift is disabled' }); return; }
  try {
    const weeks = Math.min(Math.max(Number(req.query.weeks) || 12, 4), 52);
    res.json(getNarrativeHeatmapAI(weeks));
  } catch (error) {
    logger.error('[dashboard] /api/narrative-ai/heatmap error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/narrative-ai/drift', (_req: Request, res: Response) => {
  if (!aiNarrativeEnabled()) { res.status(503).json({ error: 'AI Narrative Drift is disabled' }); return; }
  try {
    res.json(getNarrativeDriftAI());
  } catch (error) {
    logger.error('[dashboard] /api/narrative-ai/drift error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/narrative-ai/trend', (req: Request, res: Response) => {
  if (!aiNarrativeEnabled()) { res.status(503).json({ error: 'AI Narrative Drift is disabled' }); return; }
  try {
    const category = String(req.query.category ?? '');
    const days = Math.min(Math.max(Number(req.query.days) || 90, 7), 365);
    if (!category) { res.status(400).json({ error: 'category required' }); return; }
    res.json(getCategoryTrendAI(category, days));
  } catch (error) {
    logger.error('[dashboard] /api/narrative-ai/trend error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/narrative-ai/keywords', (req: Request, res: Response) => {
  if (!aiNarrativeEnabled()) { res.status(503).json({ error: 'AI Narrative Drift is disabled' }); return; }
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 14, 7), 90);
    res.json(getEmergingKeywordsAI(days));
  } catch (error) {
    logger.error('[dashboard] /api/narrative-ai/keywords error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/narrative-ai/reprocess', (_req: Request, res: Response) => {
  if (!aiNarrativeEnabled()) { res.status(503).json({ error: 'AI Narrative Drift is disabled' }); return; }
  // Respond immediately — reprocess runs in background (can take several minutes for large history)
  res.json({ ok: true, background: true });
  reprocessNarrativeHistoryAI().catch(err =>
    logger.error('[dashboard] /api/narrative-ai/reprocess background error:', err),
  );
});

export function startDashboard(): void {
  const server = app.listen(config.dashboardPort, () => {
    logger.info(`[dashboard] Listening on http://localhost:${config.dashboardPort}`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.warn(
        `[dashboard] Port ${config.dashboardPort} already in use - dashboard disabled. ` +
        `Change DASHBOARD_PORT in .env to use a different port.`,
      );
    } else {
      logger.error('[dashboard] Server error:', error);
    }
  });
}
