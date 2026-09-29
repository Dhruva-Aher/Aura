import express from 'express';
import cors from 'cors';
import { prisma } from '@aura/database';
import { queueEvents } from './services/QueueService';
import { createRedisClient } from '@aura/redis';
import { buildMetricsOverview } from './services/metricsSnapshot';
import jobsRouter from './routes/jobs';
import metricsRouter from './routes/metrics';
import systemRouter from './routes/system';
import streamRouter from './routes/stream';
import debugRouter from './routes/debug';

const app = express();
const redisSub = createRedisClient();
app.use(cors());
app.use(express.json());

// Lightweight probe for container orchestrators (no DB/Redis dependency).
app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

// Routes
app.use('/jobs', jobsRouter);
app.use('/metrics', metricsRouter);
app.use('/system', systemRouter);
app.use('/events/stream', streamRouter);
app.use('/debug', debugRouter);

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('API Error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Broadcast metrics via SSE (slower on free tier to reduce CPU + UI churn).
const METRICS_BROADCAST_MS = Number(
  process.env.METRICS_BROADCAST_MS ??
    (process.env.FREE_TIER === 'true' ? 5000 : 2000),
);
setInterval(async () => {
  try {
    const metrics = await buildMetricsOverview();
    queueEvents.emit('metrics_update', metrics);
  } catch (err) {
    console.error('Metrics broadcast error:', err);
  }
}, METRICS_BROADCAST_MS);

// Distributed event bridge: worker processes publish to Redis PubSub.
redisSub.subscribe('aura:events').then(() => {
  redisSub.on('message', (_channel: string, payload: string) => {
    try {
      const evt = JSON.parse(payload);
      if (!evt?.type) return;
      queueEvents.emit(evt.type, evt);
      if (evt.jobId) {
        queueEvents.emit('job_update', evt);
      }
    } catch (err) {
      console.error('Event bridge parse error:', err);
    }
  });
}).catch((err: unknown) => {
  console.error('Failed to subscribe to aura:events:', err);
});

let latestJobUpdateAt = new Date(0);

// Broadcast job lifecycle updates so UI reflects real status transitions.
const JOB_BROADCAST_MS = Number(
  process.env.JOB_BROADCAST_MS ??
    (process.env.FREE_TIER === 'true' ? 2000 : 1000),
);
setInterval(async () => {
  try {
    const jobs = await prisma.job.findMany({
      where: { updatedAt: { gt: latestJobUpdateAt } },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    });

    if (!jobs.length) return;
    for (const job of jobs) {
      queueEvents.emit('job_update', job);
      if (job.status === 'PROCESSING') queueEvents.emit('job_started', job);
      if (job.status === 'COMPLETED') queueEvents.emit('job_completed', job);
      if (job.status === 'FAILED' || job.status === 'DEAD_LETTER') queueEvents.emit('job_failed', job);
    }
    latestJobUpdateAt = jobs[jobs.length - 1].updatedAt;
  } catch (err) {
    console.error('Job update broadcast error:', err);
  }
}, JOB_BROADCAST_MS);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});

// Free-tier / single-service mode: run workers + scheduler in this process
// so Render Free does not need a paid Background Worker.
if (process.env.EMBEDDED_WORKER === 'true') {
  import('../../worker/src/runtime')
    .then(({ startWorkerRuntime }) => startWorkerRuntime())
    .then(() => console.log('[API] Embedded worker runtime started'))
    .catch((err: unknown) => {
      console.error('[API] Failed to start embedded worker:', err);
      process.exit(1);
    });
}
