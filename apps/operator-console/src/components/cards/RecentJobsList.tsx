import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Play, Mail, Image, FileText, LayoutDashboard } from 'lucide-react';
import { cn } from '../../utils/cn';
import { useAura } from '../../AuraContext';
import { JobDrawer } from '../modals/JobDrawer';
import { Job } from '../../services/jobsService';

const getIcon = (name: string) => {
  if (name.includes('video')) return { icon: Play, color: 'text-purple-400', bg: 'bg-purple-400/10' };
  if (name.includes('email')) return { icon: Mail, color: 'text-green-400', bg: 'bg-green-400/10' };
  if (name.includes('image') || name.includes('thumb')) return { icon: Image, color: 'text-blue-400', bg: 'bg-blue-400/10' };
  if (name.includes('report')) return { icon: FileText, color: 'text-red-400', bg: 'bg-red-400/10' };
  return { icon: LayoutDashboard, color: 'text-yellow-400', bg: 'bg-yellow-400/10' };
};

const statusStyles: Record<string, string> = {
  'PROCESSING': 'bg-status-processing/10 text-status-processing border-status-processing/20',
  'COMPLETED': 'bg-status-completed/10 text-status-completed border-status-completed/20',
  'FAILED': 'bg-status-failed/10 text-status-failed border-status-failed/20',
  'DEAD_LETTER': 'bg-status-failed/10 text-status-failed border-status-failed/20',
  'PENDING': 'bg-status-pending/10 text-status-pending border-status-pending/20',
  'DELAYED': 'bg-purple-500/10 text-purple-400 border-purple-500/20',
};

const formatTimeAgo = (dateStr: string) => {
  const s = Math.floor((new Date().getTime() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
};

export const RecentJobsList: React.FC = () => {
  const { recentJobs, replayDlq, discardDlq } = useAura();
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);

  if (!recentJobs) {
    return <div className="panel col-span-1 h-[420px] animate-pulse bg-white/5" />;
  }

  return (
    <>
      <motion.div 
        initial={{ opacity: 0, x: 10 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
        className="panel p-6 flex flex-col col-span-1 h-[420px]"
      >
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-white font-semibold">Recent Jobs</h2>
          <button className="text-xs font-medium bg-white/5 hover:bg-white/10 px-2.5 py-1 rounded border border-white/10 transition-colors">
            View all
          </button>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar space-y-4 pr-2">
          {recentJobs.map((job) => {
            const styling = getIcon(job.name);
            return (
              <div key={job.id} onClick={() => setSelectedJob(job)} className="flex items-center gap-3 group cursor-pointer hover:bg-white/[0.02] p-1 -m-1 rounded transition-colors">
                <div className={cn("p-2 rounded-lg flex-shrink-0", styling.bg)}>
                  <styling.icon className={cn("h-4 w-4", styling.color)} />
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text-main truncate group-hover:text-accent transition-colors cursor-pointer">
                    {job.name}
                  </div>
                  <div className="text-xs text-text-muted font-mono mt-0.5">
                    {job.id?.substring(0,8) ?? '—'}
                  </div>
                </div>
                
                <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                  <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full border tracking-wide", statusStyles[job.status] || statusStyles['PENDING'])}>
                    {job.status}
                  </span>
                  <span className="text-xs text-text-muted">
                    {formatTimeAgo(job.createdAt)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </motion.div>

      <JobDrawer 
        job={selectedJob} 
        isOpen={!!selectedJob} 
        onClose={() => setSelectedJob(null)} 
        onReplay={async (id) => { await replayDlq(id); setSelectedJob(null); }}
        onDiscard={async (id) => { await discardDlq(id); setSelectedJob(null); }}
      />
    </>
  );
};
