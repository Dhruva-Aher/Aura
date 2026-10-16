import React, { createContext, useContext, useEffect } from 'react';
import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query';
import { metricsService, MetricsOverview, PulsePoint } from './services/metricsService';
import { jobsService, Job, EnqueueJobPayload } from './services/jobsService';
import { systemService, WorkerInfo, SystemHealth } from './services/systemService';
import { API_BASE_URL } from './services/apiClient';
import { readDashboardCache, writeDashboardCache } from './services/dashboardCache';
import toast from 'react-hot-toast';

const cachedDashboard = readDashboardCache();

/** Keep retrying while Render is waking. Once data exists, SSE owns live updates. */
const wakeUntilData = {
  retry: 6,
  retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 8000),
  refetchInterval: (query: { state: { data: unknown } }) => (query.state.data == null ? 2000 : false),
} as const;

interface AuraState {
  metrics: MetricsOverview | undefined;
  pulse: PulsePoint[] | undefined;
  recentJobs: Job[] | undefined;
  workers: WorkerInfo[] | undefined;
  health: SystemHealth[] | undefined;
  enqueueJob: (payload: EnqueueJobPayload) => Promise<void>;
  replayDlq: (id: string) => Promise<void>;
  discardDlq: (id: string) => Promise<void>;
  retryJob: (id: string) => Promise<void>;
}

const AuraContext = createContext<AuraState | null>(null);

export const AuraProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const queryClient = useQueryClient();

  const { data: metrics } = useQuery({
    queryKey: ['metrics'],
    queryFn: async () => {
      const data = await metricsService.getOverview();
      writeDashboardCache({ metrics: data, metricsAt: Date.now() });
      return data;
    },
    initialData: cachedDashboard.metrics as MetricsOverview | undefined,
    initialDataUpdatedAt: cachedDashboard.metricsAt,
    ...wakeUntilData,
  });

  const { data: pulse } = useQuery({
    queryKey: ['pulse'],
    queryFn: async () => {
      const data = await metricsService.getPulse();
      writeDashboardCache({ pulse: data, pulseAt: Date.now() });
      return data;
    },
    initialData: cachedDashboard.pulse as PulsePoint[] | undefined,
    initialDataUpdatedAt: cachedDashboard.pulseAt,
    ...wakeUntilData,
  });

  const { data: recentJobs } = useQuery({
    queryKey: ['recentJobs'],
    queryFn: async () => {
      const data = await jobsService.getRecent();
      writeDashboardCache({ recentJobs: data, recentJobsAt: Date.now() });
      return data;
    },
    initialData: cachedDashboard.recentJobs as Job[] | undefined,
    initialDataUpdatedAt: cachedDashboard.recentJobsAt,
    ...wakeUntilData,
  });

  const { data: workers } = useQuery({
    queryKey: ['workers'],
    queryFn: async () => {
      const data = await systemService.getWorkers();
      writeDashboardCache({ workers: data, workersAt: Date.now() });
      return data;
    },
    initialData: cachedDashboard.workers as WorkerInfo[] | undefined,
    initialDataUpdatedAt: cachedDashboard.workersAt,
    ...wakeUntilData,
  });

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: systemService.getHealth,
    refetchInterval: 10000,
  });

  const enqueueMutation = useMutation({
    mutationFn: jobsService.enqueue,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recentJobs'] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
      // Toast handled by EnqueueJobModal
    },
  });

  const replayMutation = useMutation({
    mutationFn: jobsService.replayDlq,
    onSuccess: (job) => {
      queryClient.invalidateQueries({ queryKey: ['recentJobs'] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
      queryClient.invalidateQueries({ queryKey: ['dlqJobs'] });
      toast.success(`Job replayed: ${job.name}`);
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to replay job');
    }
  });

  const discardMutation = useMutation({
    mutationFn: jobsService.discardDlq,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recentJobs'] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
      queryClient.invalidateQueries({ queryKey: ['dlqJobs'] });
      toast.success('Job discarded');
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to discard job');
    }
  });

  const retryMutation = useMutation({
    mutationFn: jobsService.retryJob,
    onSuccess: (job) => {
      queryClient.invalidateQueries({ queryKey: ['recentJobs'] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
      queryClient.invalidateQueries({ queryKey: ['dlqJobs'] });
      toast.success(`Retrying: ${job.name}`);
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to retry job');
    }
  });

  useEffect(() => {
    const evtSource = new EventSource(`${API_BASE_URL}/events/stream`);
    let pulseTimer: ReturnType<typeof setTimeout> | null = null;
    let workersTimer: ReturnType<typeof setTimeout> | null = null;

    const schedulePulseRefresh = () => {
      if (pulseTimer) return;
      pulseTimer = setTimeout(() => {
        pulseTimer = null;
        queryClient.invalidateQueries({ queryKey: ['pulse'] });
      }, 2500);
    };

    const scheduleWorkersRefresh = () => {
      if (workersTimer) return;
      workersTimer = setTimeout(() => {
        workersTimer = null;
        queryClient.invalidateQueries({ queryKey: ['workers'] });
      }, 5000);
    };

    evtSource.addEventListener('metrics_update', (e) => {
      try {
        const data = JSON.parse(e.data);
        queryClient.setQueryData(['metrics'], data as MetricsOverview);
        writeDashboardCache({ metrics: data, metricsAt: Date.now() });
        // Debounce extra HTTP fetches — free-tier can't keep up with invalidate storms.
        schedulePulseRefresh();
        scheduleWorkersRefresh();
      } catch {}
    });

    evtSource.addEventListener('job_update', (e) => {
      try {
        const job = JSON.parse(e.data);
        if (!job?.id) return;
        queryClient.setQueryData<Job[]>(['recentJobs'], (old) => {
          if (!old) return [job];
          return [job, ...old.filter(j => j.id !== job.id)].slice(0, 10);
        });
        // Metrics already stream on an interval — don't refetch on every job.
        schedulePulseRefresh();
      } catch {}
    });

    evtSource.onerror = () => {
      // SSE disconnect is non-fatal — React Query keeps last known data.
    };

    return () => {
      if (pulseTimer) clearTimeout(pulseTimer);
      if (workersTimer) clearTimeout(workersTimer);
      evtSource.close();
    };
  }, [queryClient]);

  const value: AuraState = {
    metrics,
    pulse,
    recentJobs,
    workers,
    health,
    enqueueJob: async (data) => { await enqueueMutation.mutateAsync(data); },
    replayDlq: async (id) => { await replayMutation.mutateAsync(id); },
    discardDlq: async (id) => { await discardMutation.mutateAsync(id); },
    retryJob: async (id) => { await retryMutation.mutateAsync(id); },
  };

  return <AuraContext.Provider value={value}>{children}</AuraContext.Provider>;
};

export const useAura = () => {
  const ctx = useContext(AuraContext);
  if (!ctx) throw new Error('useAura must be used within AuraProvider');
  return ctx;
};
