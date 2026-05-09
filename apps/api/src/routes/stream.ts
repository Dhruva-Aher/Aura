import { Router } from 'express';
import { queueEvents } from '../services/QueueService';

const router = Router();

router.get('/', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const sendEvent = (type: string, data: any) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onJobUpdate = (job: any) => sendEvent('job_update', job);
  const onMetrics = (metrics: any) => sendEvent('metrics_update', metrics);
  const onJobCreated = (job: any) => sendEvent('job_created', job);
  const onJobStarted = (job: any) => sendEvent('job_started', job);
  const onJobCompleted = (job: any) => sendEvent('job_completed', job);
  const onJobFailed = (job: any) => sendEvent('job_failed', job);
  const onJobRetried = (job: any) => sendEvent('job_retried', job);
  const onJobRequeued = (job: any) => sendEvent('job_requeued', job);
  const onWorkerHeartbeat = (worker: any) => sendEvent('worker_heartbeat', worker);

  queueEvents.on('job_update', onJobUpdate);
  queueEvents.on('job_created', onJobCreated);
  queueEvents.on('job_started', onJobStarted);
  queueEvents.on('job_completed', onJobCompleted);
  queueEvents.on('job_failed', onJobFailed);
  queueEvents.on('job_retried', onJobRetried);
  queueEvents.on('job_requeued', onJobRequeued);
  queueEvents.on('worker_heartbeat', onWorkerHeartbeat);
  queueEvents.on('metrics_update', onMetrics);

  const ping = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(ping);
    queueEvents.off('job_update', onJobUpdate);
    queueEvents.off('job_created', onJobCreated);
    queueEvents.off('job_started', onJobStarted);
    queueEvents.off('job_completed', onJobCompleted);
    queueEvents.off('job_failed', onJobFailed);
    queueEvents.off('job_retried', onJobRetried);
    queueEvents.off('job_requeued', onJobRequeued);
    queueEvents.off('worker_heartbeat', onWorkerHeartbeat);
    queueEvents.off('metrics_update', onMetrics);
  });
});

export default router;
