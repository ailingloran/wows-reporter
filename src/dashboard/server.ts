/**
 * Optional Express web dashboard.
 * Password-protected via Basic Auth. Reads directly from SQLite.
 * Access at http://localhost:3000 (or via Nginx reverse proxy).
 */

import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { config } from '../config';
import { logger } from '../logger';
import {
  getDb,
  getSnapshotsBetween,
  getPlayerRoleSnapshotsBetween,
  getChannelStatsForSnapshot,
} from '../store/db';

const app = express();

// ── Basic Auth middleware ──────────────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const auth = req.headers.authorization;
  if (auth) {
    const [, encoded] = auth.split(' ');
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const [, password] = decoded.split(':');
    if (password === config.dashboardSecret) {
      return next();
    }
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="WoWS Reporter Dashboard"');
  res.status(401).send('Unauthorized');
});

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API routes (JSON) ─────────────────────────────────────────────────────────

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

/** Channel stats for latest snapshot */
app.get('/api/channels', (_req: Request, res: Response) => {
  try {
    const latest = getDb()
      .prepare(`SELECT id FROM snapshots WHERE period = 'daily' ORDER BY taken_at DESC LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!latest) return res.json([]);
    const channels = getChannelStatsForSnapshot(latest.id);
    res.json(channels);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
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
