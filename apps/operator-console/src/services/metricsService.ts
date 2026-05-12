import { apiClient } from './apiClient';

export type MetricInfo = { value: number; change?: number; trend?: 'up' | 'down' | 'flat' };
export type MetricsOverview = {
  active: MetricInfo;
  processing: MetricInfo;
  completed: MetricInfo;
  failed: MetricInfo;
  delayed: MetricInfo;
  // Latency percentiles (queue wait time, seconds)
  p50Latency?: number;
  p95Latency?: number;
  p99Latency?: number;
  latencyChange?: number;
  // Throughput
  throughput?: number;
  throughputChange?: number;
  completed1h?: number;
  failed1h?: number;
  // Worker metrics
  workerUtilization?: number;
  totalWorkers?: number;
  activeWorkers?: number;
  // Rates
  drainRate?: number;
  retryRate?: number;
  failureRate?: number;
  processingTimeP95?: number;
  // Backpressure
  backpressure?: { accepted: number; rejected: number; rejectionRate: number };
  // Queue breakdown
  queueDepth?: { high: number; default: number; low: number };
};
export type PulsePoint = { time: string; completed: number; failed: number; scheduled: number; latency?: number; throughput?: number };

export const metricsService = {
  getOverview: () => apiClient.get<MetricsOverview>('/metrics/overview'),
  getPulse: () => apiClient.get<PulsePoint[]>('/metrics/pulse'),
};
