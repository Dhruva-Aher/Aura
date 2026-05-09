import { apiClient } from './apiClient';

export interface Job {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  idempotencyKey: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  payload: any;
  errorLog: any;
  scheduledFor?: string;
}

export interface EnqueueJobPayload {
  name: string;
  payload: any;
  priority?: number;
  scheduledFor?: string;
  maxAttempts?: number;
}

export interface CursorPage<T> {
  items: T[];
  total: number;
  nextCursor: { cursorCreatedAt: string; cursorId: string } | null;
}

export const jobsService = {
  getRecent: (limit = 10) => apiClient.get<Job[]>(`/jobs/recent?limit=${limit}`),
  getDlq: (params?: { limit?: number; cursorCreatedAt?: string; cursorId?: string }) => {
    const q = new URLSearchParams();
    q.set('limit', String(params?.limit ?? 50));
    if (params?.cursorCreatedAt) q.set('cursorCreatedAt', params.cursorCreatedAt);
    if (params?.cursorId) q.set('cursorId', params.cursorId);
    return apiClient.get<CursorPage<Job>>(`/jobs/dlq?${q.toString()}`);
  },
  search: (params: { search?: string; status?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (params.search) q.set('search', params.search);
    if (params.status) q.set('status', params.status);
    if (params.limit) q.set('limit', String(params.limit));
    return apiClient.get<CursorPage<Job>>(`/jobs?${q.toString()}`);
  },
  list: (params?: { search?: string; status?: string; limit?: number; cursorCreatedAt?: string; cursorId?: string }) => {
    const q = new URLSearchParams();
    if (params?.search) q.set('search', params.search);
    if (params?.status) q.set('status', params.status);
    q.set('limit', String(params?.limit ?? 100));
    if (params?.cursorCreatedAt) q.set('cursorCreatedAt', params.cursorCreatedAt);
    if (params?.cursorId) q.set('cursorId', params.cursorId);
    return apiClient.get<CursorPage<Job>>(`/jobs?${q.toString()}`);
  },
  enqueue: (data: EnqueueJobPayload) =>
    apiClient.post<Job>('/jobs', { ...data, idempotencyKey: crypto.randomUUID() }),
  replayDlq: (id: string) => apiClient.post<Job>(`/jobs/${id}/replay`),
  discardDlq: (id: string) => apiClient.post<Job>(`/jobs/${id}/discard`),
  retryJob: (id: string) => apiClient.post<Job>(`/jobs/${id}/retry`),
};
