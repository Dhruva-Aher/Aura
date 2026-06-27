import React, { createContext, useContext, useEffect } from 'react';
import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query';
import { metricsService, MetricsOverview, PulsePoint } from './services/metricsService';
import { jobsService, Job, EnqueueJobPayload } from './services/jobsService';
import { systemService, WorkerInfo, SystemHealth } from './services/systemService';
import { API_BASE_URL } from './services/apiClient';
import toast from 'react-hot-toast';

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
    queryFn: metricsService.getOverview,
  });

  const { data: pulse } = useQuery({
    queryKey: ['pulse'],
    queryFn: metricsService.getPulse,
  });

  const { data: recentJobs } = useQuery({
    queryKey: ['recentJobs'],
    queryFn: () => jobsService.getRecent(),
  });

  const { data: workers } = useQuery({
    queryKey: ['workers'],
    queryFn: systemService.getWorkers,
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

    evtSource.addEventListener('metrics_update', (e) => {
      try {
        const data = JSON.parse(e.data);
        queryClient.setQueryData(['metrics'], data as MetricsOverview);
        queryClient.invalidateQueries({ queryKey: ['pulse'] });
        queryClient.invalidateQueries({ queryKey: ['workers'] });
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
        queryClient.invalidateQueries({ queryKey: ['metrics'] });
        queryClient.invalidateQueries({ queryKey: ['pulse'] });
      } catch {}
    });

    evtSource.onerror = () => {
      // SSE disconnect is non-fatal — polling handles real-time updates
    };

    return () => evtSource.close();
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
