import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Job } from '../../services/jobsService';
import { WorkerInfo } from '../../services/systemService';

function timeHMS(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function timeAgo(dateStr: string) {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function MiniSparkBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="w-16 h-1 bg-white/10 rounded-full overflow-hidden">
      <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${Math.min(value, 100)}%`, background: color }} />
    </div>
  );
}

function parseMemMB(mem: string | undefined): number {
  if (!mem) return 0;
  const n = parseFloat(mem);
  return isNaN(n) ? 0 : n;
}

export const WorkersTable: React.FC<{ workers: WorkerInfo[]; jobs: Job[]; onJobClick: (j: Job) => void }> = ({ workers, jobs, onJobClick }) => {
  const navigate = useNavigate();

  return (
    <div className="panel flex flex-col h-full overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between bg-background-panel">
        <div className="flex items-center gap-3">
          <h3 className="text-[20px] font-semibold text-text-primary">Active Workers</h3>
          <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-accent-green bg-accent-green/10 border border-accent-green/20 px-2.5 py-1 rounded-full">
            {workers.filter(w => w.status === 'ONLINE').length} online
          </span>
        </div>
        <button onClick={() => navigate('/workers')} className="flex items-center gap-1.5 text-[12px] font-medium text-accent-indigo hover:text-indigo-400 transition-colors group">
          View all workers <ArrowUpRight size={16} className="group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
        </button>
      </div>
      
      <div className="overflow-x-auto flex-1 bg-background-panel">
        <table className="w-full text-left whitespace-nowrap min-w-[800px]">
          <thead className="bg-background-main text-text-muted text-[10px] uppercase font-semibold tracking-[0.12em] border-b border-border">
            <tr>
              <th className="px-5 py-3.5 font-semibold">Worker ID</th>
              <th className="px-5 py-3.5 font-semibold">Pool <span className="text-text-secondary ml-1">↕</span></th>
              <th className="px-5 py-3.5 font-semibold">Current Job</th>
              <th className="px-5 py-3.5 font-semibold">Started At</th>
              <th className="px-5 py-3.5 font-semibold">Heartbeats</th>
              <th className="px-5 py-3.5 font-semibold">CPU</th>
              <th className="px-5 py-3.5 font-semibold">Memory</th>
              <th className="px-5 py-3.5 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {workers.map(w => {
              const currentJob = jobs.find(j => j.id === w.currentJobId);
              return (
                <tr key={w.id} className="hover:bg-white/5 transition-colors group">
                  <td className="px-5 py-3.5 font-mono text-[12px] font-medium text-text-primary">{w.id}</td>
                  <td className="px-5 py-3.5 text-[12px] text-text-secondary font-mono">{w.pool ?? 'default'}</td>
                  <td className="px-5 py-3.5 text-[12px] font-medium">
                    {w.currentJobId ? (
                      <button
                        onClick={() => currentJob && onJobClick(currentJob)}
                        className="text-accent-indigo hover:text-indigo-400 hover:underline text-left transition-colors"
                      >
                        {currentJob ? `${currentJob.name} (${w.currentJobId.substring(0, 8)})` : w.currentJobId.substring(0, 8)}
                      </button>
                    ) : <span className="text-text-muted italic">Idle</span>}
                  </td>
                  <td className="px-5 py-3.5 text-[12px] font-mono text-text-secondary">{w.startedAt ? timeHMS(w.startedAt) : '—'}</td>
                  <td className="px-5 py-3.5 text-[12px] font-medium text-text-secondary">{w.lastHeartbeat ? timeAgo(w.lastHeartbeat) : '—'}</td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <span className="text-[12px] font-medium text-text-secondary w-9">{w.cpu ?? 0}%</span>
                      <MiniSparkBar value={w.cpu ?? 0} color="#6366F1" />
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <MiniSparkBar value={parseMemMB(w.memory) / 3} color="#8B5CF6" />
                      <span className="text-[12px] font-medium text-text-secondary w-12 text-right">{w.memory ?? '—'}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    {w.status === 'ONLINE'
                      ? <span className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-accent-green bg-accent-green/10 border border-accent-green/20 px-2.5 py-1 rounded-full w-fit">
                          <div className="h-1.5 w-1.5 bg-accent-green rounded-full shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse" />ONLINE
                        </span>
                      : <span className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-text-muted bg-white/5 border border-white/10 px-2.5 py-1 rounded-full w-fit">
                          <div className="h-1.5 w-1.5 bg-text-muted rounded-full" />OFFLINE
                        </span>
                    }
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
