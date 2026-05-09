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

// Broadcast metrics every 2 seconds via SSE
setInterval(async () => {
  try {
    const metrics = await buildMetricsOverview();
    queueEvents.emit('metrics_update', metrics);
  } catch (err) {
    console.error('Metrics broadcast error:', err);
  }
}, 2000);

// Distributed event bridge: worker processes publish to Redis PubSub.
redisSub.subscribe('aura:events').then(() => {
  redisSub.on('message', (_channel, payload) => {
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
}).catch((err) => {
  console.error('Failed to subscribe to aura:events:', err);
});

let latestJobUpdateAt = new Date(0);

// Broadcast job lifecycle updates so UI reflects real status transitions.
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
}, 1000);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
