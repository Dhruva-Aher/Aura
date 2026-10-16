import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query';
import { metricsService, MetricsOverview, PulsePoint } from './services/metricsService';
import { jobsService, Job, EnqueueJobPayload } from './services/jobsService';
import { systemService, WorkerInfo, SystemHealth } from './services/systemService';
import { API_BASE_URL } from './services/apiClient';
import { readDashboardCache, writeDashboardCache } from './services/dashboardCache';
import toast from 'react-hot-toast';

const cachedDashboard = readDashboardCache();

/** Retry while Render is waking. After the first payload, only the steady interval runs. */
const wakeRetry = {
  retry: 8,
  retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 8000),
} as const;

function pollAfterWake(steadyMs: number | false) {
  return (query: { state: { data: unknown } }) => (query.state.data == null ? 2000 : steadyMs);
}

function useDelayedEnabled(ready: boolean, delayMs: number) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!ready || enabled) return;
    const timer = setTimeout(() => setEnabled(true), delayMs);
    return () => clearTimeout(timer);
  }, [ready, delayMs, enabled]);
  return enabled;
}

function rememberRecentJob(queryClient: ReturnType<typeof useQueryClient>, job: Job) {
  queryClient.setQueryData<Job[]>(['recentJobs'], (old) => {
    const recent = [job, ...(old ?? []).filter((item) => item.id !== job.id)].slice(0, 10);
    writeDashboardCache({ recentJobs: recent, recentJobsAt: Date.now() });
    return recent;
  });
}

function sameMetrics(a: MetricsOverview, b: MetricsOverview) {
  return a.active?.value === b.active?.value
    && a.processing?.value === b.processing?.value
    && a.completed?.value === b.completed?.value
    && a.failed?.value === b.failed?.value
    && a.delayed?.value === b.delayed?.value
    && a.p95Latency === b.p95Latency
    && a.throughput === b.throughput
    && a.latencyChange === b.latencyChange
    && a.throughputChange === b.throughputChange;
}

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

const MetricsContext = createContext<MetricsOverview | undefined | null>(null);
const PulseContext = createContext<PulsePoint[] | undefined | null>(null);
const JobsContext = createContext<Job[] | undefined | null>(null);
const WorkersContext = createContext<WorkerInfo[] | undefined | null>(null);
const HealthContext = createContext<SystemHealth[] | undefined | null>(null);
const ActionsContext = createContext<Pick<AuraState, 'enqueueJob' | 'replayDlq' | 'discardDlq' | 'retryJob'> | null>(null);

export const AuraProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const queryClient = useQueryClient();
  const [streamEpoch, setStreamEpoch] = useState(0);

  const { data: metrics } = useQuery({
    queryKey: ['metrics'],
    queryFn: async () => {
      const data = await metricsService.getOverview();
      writeDashboardCache({ metrics: data, metricsAt: Date.now() });
      return data;
    },
    initialData: cachedDashboard.metrics as MetricsOverview | undefined,
    initialDataUpdatedAt: cachedDashboard.metricsAt,
    ...wakeRetry,
    refetchInterval: pollAfterWake(false),
  });

  const metricsReady = metrics != null;
  const jobsEnabled = useDelayedEnabled(metricsReady, 600);
  const pulseEnabled = useDelayedEnabled(metricsReady, 1_600);
  const workersEnabled = useDelayedEnabled(metricsReady, 2_800);
  const healthEnabled = useDelayedEnabled(metricsReady, 4_500);
  const steadyRetry = {
    retry: 3,
    retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 8_000),
  } as const;

  const { data: pulse } = useQuery({
    queryKey: ['pulse'],
    queryFn: async () => {
      const data = await metricsService.getPulse();
      writeDashboardCache({ pulse: data, pulseAt: Date.now() });
      return data;
    },
    initialData: cachedDashboard.pulse as PulsePoint[] | undefined,
    initialDataUpdatedAt: cachedDashboard.pulseAt,
    ...steadyRetry,
    enabled: pulseEnabled,
    refetchInterval: pollAfterWake(15_000),
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
    ...steadyRetry,
    enabled: jobsEnabled,
    refetchInterval: pollAfterWake(false),
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
    ...steadyRetry,
    enabled: workersEnabled,
    refetchInterval: pollAfterWake(20_000),
  });

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: systemService.getHealth,
    ...steadyRetry,
    enabled: healthEnabled,
    refetchInterval: 60_000,
  });

  const enqueueMutation = useMutation({
    mutationFn: jobsService.enqueue,
    onSuccess: (job) => {
      rememberRecentJob(queryClient, job);
    },
  });

  const replayMutation = useMutation({
    mutationFn: jobsService.replayDlq,
    onSuccess: (job) => {
      rememberRecentJob(queryClient, job);
      queryClient.invalidateQueries({ queryKey: ['dlqJobs'] });
      toast.success(`Job replayed: ${job.name}`);
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to replay job');
    }
  });

  const discardMutation = useMutation({
    mutationFn: jobsService.discardDlq,
    onSuccess: (job) => {
      queryClient.setQueryData<Job[]>(['recentJobs'], (old) => (old ?? []).filter((item) => item.id !== job.id));
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
      rememberRecentJob(queryClient, job);
      queryClient.invalidateQueries({ queryKey: ['dlqJobs'] });
      toast.success(`Retrying: ${job.name}`);
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to retry job');
    }
  });

  useEffect(() => {
    const evtSource = new EventSource(`${API_BASE_URL}/events/stream`);
    let lastEventAt = Date.now();
    const pendingJobs = new Map<string, Job>();
    let jobTimer: ReturnType<typeof setTimeout> | null = null;

    const mark = () => {
      lastEventAt = Date.now();
    };

    const flushJobs = () => {
      jobTimer = null;
      if (!pendingJobs.size) return;
      const batch = [...pendingJobs.values()];
      pendingJobs.clear();
      queryClient.setQueryData<Job[]>(['recentJobs'], (old) => {
        let next = old ?? [];
        for (const job of batch) {
          next = [job, ...next.filter((item) => item.id !== job.id)];
        }
        const recent = next.slice(0, 10);
        writeDashboardCache({ recentJobs: recent, recentJobsAt: Date.now() });
        return recent;
      });
    };

    const onMetrics = (event: Event) => {
      mark();
      try {
        const data = JSON.parse((event as MessageEvent).data) as MetricsOverview;
        if (!data?.active || typeof data.active.value !== 'number') return;
        const prev = queryClient.getQueryData<MetricsOverview>(['metrics']);
        if (prev && sameMetrics(prev, data)) return;
        queryClient.setQueryData(['metrics'], data);
        writeDashboardCache({ metrics: data, metricsAt: Date.now() });
      } catch {
        // Ignore a malformed metrics frame.
      }
    };

    const onJob = (event: Event) => {
      mark();
      try {
        const job = JSON.parse((event as MessageEvent).data) as Job;
        if (!job?.id) return;
        pendingJobs.set(job.id, job);
        if (jobTimer) return;
        jobTimer = setTimeout(flushJobs, 300);
      } catch {
        // Ignore a malformed job frame.
      }
    };

    evtSource.addEventListener('metrics_update', onMetrics);
    evtSource.addEventListener('job_update', onJob);

    const watch = setInterval(() => {
      if (evtSource.readyState === EventSource.OPEN && Date.now() - lastEventAt > 20_000) {
        evtSource.close();
        setStreamEpoch((n) => n + 1);
      }
    }, 5_000);

    return () => {
      clearInterval(watch);
      if (jobTimer) clearTimeout(jobTimer);
      evtSource.close();
    };
  }, [queryClient, streamEpoch]);

  const actions = useMemo(() => ({
    enqueueJob: async (data: EnqueueJobPayload) => { await enqueueMutation.mutateAsync(data); },
    replayDlq: async (id: string) => { await replayMutation.mutateAsync(id); },
    discardDlq: async (id: string) => { await discardMutation.mutateAsync(id); },
    retryJob: async (id: string) => { await retryMutation.mutateAsync(id); },
  }), [
    enqueueMutation.mutateAsync,
    replayMutation.mutateAsync,
    discardMutation.mutateAsync,
    retryMutation.mutateAsync,
  ]);

  return (
    <MetricsContext.Provider value={metrics}>
      <PulseContext.Provider value={pulse}>
        <JobsContext.Provider value={recentJobs}>
          <WorkersContext.Provider value={workers}>
            <HealthContext.Provider value={health}>
              <ActionsContext.Provider value={actions}>
                {children}
              </ActionsContext.Provider>
            </HealthContext.Provider>
          </WorkersContext.Provider>
        </JobsContext.Provider>
      </PulseContext.Provider>
    </MetricsContext.Provider>
  );
};

function useSlice<T>(context: React.Context<T | undefined | null>, name: string): T | undefined {
  const value = useContext(context);
  if (value === null) throw new Error(`${name} must be used within AuraProvider`);
  return value;
}

export const useMetrics = () => useSlice(MetricsContext, 'useMetrics');
export const usePulse = () => useSlice(PulseContext, 'usePulse');
export const useRecentJobs = () => useSlice(JobsContext, 'useRecentJobs');
export const useWorkers = () => useSlice(WorkersContext, 'useWorkers');
export const useHealth = () => useSlice(HealthContext, 'useHealth');

export const useActions = () => {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error('useActions must be used within AuraProvider');
  return actions;
};

export const useAura = (): AuraState => {
  const actions = useActions();
  return {
    metrics: useMetrics(),
    pulse: usePulse(),
    recentJobs: useRecentJobs(),
    workers: useWorkers(),
    health: useHealth(),
    ...actions,
  };
};
