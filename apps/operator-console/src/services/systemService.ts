import { apiClient } from './apiClient';

export interface WorkerInfo {
  id: string;
  pool: string;
  status: string;
  startedAt: string;
  lastHeartbeat: string;
  cpu: number;
  memory: string;
  currentJobId: string | null;
}

export interface SystemHealth {
  name: string;
  status: string;
  ms: string;
  state: string;
}

export const systemService = {
  getWorkers: () => apiClient.get<WorkerInfo[]>('/system/workers'),
  getHealth: () => apiClient.get<SystemHealth[]>('/system/health'),
};
