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
  getSnapshotsBetween,
} from '../store/db';
import { createChatJob, getChatJobResponse, listRecentChatJobs } from './chatJobs';

const app = express();
app.use(express.json());

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin ?? '';
  if (origin.startsWith('http://localhost') || origin.includes('dockworks.dev')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
    const lastDaily = getLastSnapshot('daily');
    const lastMonthly = getLastSnapshot('monthly');
    const lastSentiment = getLastSentimentReport();
    res.json({
      uptime: process.uptime(),
      lastDailyAt: lastDaily?.taken_at ?? null,
      lastMonthlyAt: lastMonthly?.taken_at ?? null,
      lastSentimentAt: lastSentiment?.taken_at ?? null,
      lastMood: lastSentiment?.mood ?? null,
    });
  } catch (error) {
    logger.error('[dashboard] /api/status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/daily', (_req: Request, res: Response) => {
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const rows = getSnapshotsBetween('daily', from.toISOString(), to.toISOString());
    res.json(rows);
  } catch (error) {
    logger.error('[dashboard] /api/daily error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/monthly', (_req: Request, res: Response) => {
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
    const rows = getSnapshotsBetween('monthly', from.toISOString(), to.toISOString());
    res.json(rows);
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

app.get('/api/chat', (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  res.json(listRecentChatJobs(limit));
});

app.post('/api/chat', (req: Request, res: Response) => {
  const { question, windowHours = 24, collectCap = 3000 } = req.body as {
    question: string;
    windowHours: number;
    collectCap: number;
  };

  if (!question?.trim()) {
    res.status(400).json({ error: 'question is required' });
    return;
  }

  if (!config.sentimentChannelIds.length) {
    res.status(400).json({ error: 'SENTIMENT_CHANNEL_IDS not configured' });
    return;
  }

  const cappedHours = Math.min(Math.max(Number(windowHours) || 24, 1), 720);
  const cappedCap = Math.min(Math.max(Number(collectCap) || 3000, 50), 10_000);

  logger.info(`[dashboard] Chat queued - window: ${cappedHours}h, cap: ${cappedCap}, q: "${question}"`);
  const job = createChatJob(question.trim(), cappedHours, cappedCap);
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

app.post('/api/trigger/daily', (_req: Request, res: Response) => {
  import('../reports/daily').then(({ runDailyReport }) => {
    runDailyReport().catch((error: unknown) => logger.error('[dashboard] Triggered daily report failed:', error));
    res.json({ ok: true, message: 'Daily report triggered' });
  }).catch(() => res.status(500).json({ error: 'Failed to load report module' }));
});

app.post('/api/trigger/sentiment', (_req: Request, res: Response) => {
  import('../reports/sentiment').then(({ runSentimentReport }) => {
    runSentimentReport().catch((error: unknown) => logger.error('[dashboard] Triggered sentiment report failed:', error));
    res.json({ ok: true, message: 'Sentiment report triggered' });
  }).catch(() => res.status(500).json({ error: 'Failed to load report module' }));
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', uptime: process.uptime() });
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
