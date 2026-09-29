/**
 * Worker process entry point.
 * See runtime.ts for the shared bootstrap used by free single-service deploys.
 */

import { startWorkerRuntime } from './runtime';

startWorkerRuntime().catch((err) => {
  console.error('[Bootstrap] Fatal startup error:', err);
  process.exit(1);
});
