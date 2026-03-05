/**
 * Express web dashboard + internal REST API.
 * Supports Basic Auth (browser) and Bearer token (Next.js dashboard calls).
 * Reads directly from SQLite; trigger endpoints fire bot report jobs.
 */

import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { config } from '../config';
import { logger } from '../logger';
import {
  getDb,
  getSnapshotsBetween,
  getChannelStatsForSnapshot,
  getSentimentReports,
  getLastSnapshot,
  getLastSentimentReport,
} from '../store/db';

const app = express();
app.use(express.json());

// ── CORS (allow Next.js frontend) ─────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin ?? '';
  if (origin.startsWith('http://localhost') || origin.includes('dockworks.dev')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// ── Auth middleware ────────────────────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const auth = req.headers.authorization ?? '';

  // Bearer token (Next.js internal API calls)
  if (auth.startsWith('Bearer ')) {
    if (auth.slice(7) === config.dashboardSecret) return next();
  }

  // Basic Auth (browser access)
  if (auth.startsWith('Basic ')) {
    const decoded  = Buffer.from(auth.slice(6), 'base64').toString('utf-8');
    const password = decoded.split(':')[1];
    if (password === config.dashboardSecret) return next();
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="WoWS Reporter Dashboard"');
  res.status(401).json({ error: 'Unauthorized' });
});

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API routes ────────────────────────────────────────────────────────────────

/** Bot status — uptime + last report timestamps */
app.get('/api/status', (_req: Request, res: Response) => {
  try {
    const lastDaily     = getLastSnapshot('daily');
    const lastMonthly   = getLastSnapshot('monthly');
    const lastSentiment = getLastSentimentReport();
    res.json({
      uptime:          process.uptime(),
      lastDailyAt:     lastDaily?.taken_at     ?? null,
      lastMonthlyAt:   lastMonthly?.taken_at   ?? null,
      lastSentimentAt: lastSentiment?.taken_at ?? null,
      lastMood:        lastSentiment?.mood      ?? null,
    });
  } catch (err) {
    logger.error('[dashboard] /api/status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Last 30 daily snapshots */
app.get('/api/daily', (_req: Request, res: Response) => {
  try {
    const to   = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const rows = getSnapshotsBetween('daily', from.toISOString(), to.toISOString());
    res.json(rows);
  } catch (err) {
    logger.error('[dashboard] /api/daily error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Last 12 monthly snapshots */
app.get('/api/monthly', (_req: Request, res: Response) => {
  try {
    const to   = new Date();
    const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
    const rows = getSnapshotsBetween('monthly', from.toISOString(), to.toISOString());
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** @Player role history (all time) */
app.get('/api/players', (_req: Request, res: Response) => {
  try {
    const rows = getDb()
      .prepare(`SELECT * FROM player_role_snapshots ORDER BY snapshot_date ASC`)
      .all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Channel stats for latest daily snapshot */
app.get('/api/channels', (_req: Request, res: Response) => {
  try {
    const latest = getDb()
      .prepare(`SELECT id FROM snapshots WHERE period = 'daily' ORDER BY taken_at DESC LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!latest) { res.json([]); return; }
    res.json(getChannelStatsForSnapshot(latest.id));
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Last N sentiment reports (default 30, max 100) */
app.get('/api/sentiment', (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    res.json(getSentimentReports(limit));
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Community chat — freeform question about recent messages */
app.post('/api/chat', async (req: Request, res: Response) => {
  const { question, windowHours = 24, collectCap = 3000 } = req.body as {
    question:    string;
    windowHours: number;
    collectCap:  number;
  };

  if (!question?.trim()) {
    res.status(400).json({ error: 'question is required' });
    return;
  }

  try {
    const { collectMessagesForWindow } = await import('../collectors/messageCollector');
    const { answerQuestion }           = await import('../api/openai');
    const { config: cfg }              = await import('../config');

    if (!cfg.sentimentChannelIds.length) {
      res.status(400).json({ error: 'SENTIMENT_CHANNEL_IDS not configured' });
      return;
    }

    const cappedHours = Math.min(Math.max(Number(windowHours) || 24, 1), 720);
    const cappedCap   = Math.min(Math.max(Number(collectCap)  || 3000, 50), 10_000);

    logger.info(`[dashboard] Chat — window: ${cappedHours}h, cap: ${cappedCap}, q: "${question}"`);

    const messages = await collectMessagesForWindow(cfg.sentimentChannelIds, cappedHours, cappedCap);
    if (messages.length < 5) {
      res.json({ answer: 'Not enough messages found in that time window to answer meaningfully.', collected: messages.length, analysed: 0 });
      return;
    }

    const result = await answerQuestion(messages, question);
    if (!result) {
      res.status(500).json({ error: 'OpenAI request failed' });
      return;
    }

    res.json(result);
  } catch (err) {
    logger.error('[dashboard] /api/chat error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Trigger daily report (fire-and-forget) */
app.post('/api/trigger/daily', (_req: Request, res: Response) => {
  import('../reports/daily').then(({ runDailyReport }) => {
    runDailyReport().catch((err: unknown) =>
      logger.error('[dashboard] Triggered daily report failed:', err));
    res.json({ ok: true, message: 'Daily report triggered' });
  }).catch(() => res.status(500).json({ error: 'Failed to load report module' }));
});

/** Trigger Community Pulse (fire-and-forget) */
app.post('/api/trigger/sentiment', (_req: Request, res: Response) => {
  import('../reports/sentiment').then(({ runSentimentReport }) => {
    runSentimentReport().catch((err: unknown) =>
      logger.error('[dashboard] Triggered sentiment report failed:', err));
    res.json({ ok: true, message: 'Sentiment report triggered' });
  }).catch(() => res.status(500).json({ error: 'Failed to load report module' }));
});

/** Health check */
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Start ─────────────────────────────────────────────────────────────────────
export function startDashboard(): void {
  const server = app.listen(config.dashboardPort, () => {
    logger.info(`[dashboard] Listening on http://localhost:${config.dashboardPort}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(
        `[dashboard] Port ${config.dashboardPort} already in use — dashboard disabled. ` +
        `Change DASHBOARD_PORT in .env to use a different port.`
      );
    } else {
      logger.error('[dashboard] Server error:', err);
    }
  });
}
