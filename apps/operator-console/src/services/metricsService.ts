import { apiClient } from './apiClient';

export type MetricInfo = { value: number; change?: number; trend?: 'up' | 'down' | 'flat' };
export type MetricsOverview = {
  active: MetricInfo;
  processing: MetricInfo;
  completed: MetricInfo;
  failed: MetricInfo;
  delayed: MetricInfo;
  p95Latency?: number;
  latencyChange?: number;
  throughput?: number;
  throughputChange?: number;
  completed1h?: number;
  failed1h?: number;
};
export type PulsePoint = { time: string; completed: number; failed: number; scheduled: number; latency?: number; throughput?: number };

export const metricsService = {
  getOverview: () => apiClient.get<MetricsOverview>('/metrics/overview'),
  getPulse: () => apiClient.get<PulsePoint[]>('/metrics/pulse'),
};
