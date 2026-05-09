import React from 'react';
import { ArrowUpRight, Play, Mail, Image, FileText, Database } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Job } from '../../services/jobsService';

function timeAgo(dateStr: string) {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function getJobIcon(name: string) {
  const n = name.toLowerCase();
  if (n.includes('video') || n.includes('encode') || n.includes('process')) return <Play size={16} />;
  if (n.includes('email') || n.includes('send') || n.includes('mail'))       return <Mail size={16} />;
  if (n.includes('image') || n.includes('thumbnail') || n.includes('resize'))return <Image size={16} />;
  if (n.includes('report') || n.includes('summary') || n.includes('batch'))  return <FileText size={16} />;
  return <Database size={16} />;
}

const STATUS_CHIP: Record<string, string> = {
  PROCESSING: 'text-accent-blue bg-accent-blue/10 border-accent-blue/20',
  COMPLETED:  'text-accent-green bg-accent-green/10 border-accent-green/20',
  FAILED:     'text-accent-red bg-accent-red/10 border-accent-red/20',
  DEAD_LETTER:'text-accent-red bg-accent-red/10 border-accent-red/20',
  PENDING:    'text-accent-yellow bg-accent-yellow/10 border-accent-yellow/20',
  DELAYED:    'text-accent-purple bg-accent-purple/10 border-accent-purple/20',
};

export const RecentJobsPanel: React.FC<{ jobs: Job[]; onJobClick: (j: Job) => void }> = ({ jobs, onJobClick }) => {
  const navigate = useNavigate();

  return (
    <div className="panel p-5 flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-text-primary text-[20px]">Recent Jobs</h3>
        <button onClick={() => navigate('/jobs')} className="text-[12px] font-medium text-accent-indigo hover:text-indigo-400 transition-colors">
          View all
        </button>
      </div>
      
      <div className="flex-1 space-y-2.5 overflow-y-auto custom-scrollbar pr-1">
        {jobs.map(job => (
          <div 
            key={job.id}
            onClick={() => onJobClick(job)} 
            className="flex items-center justify-between p-2.5 rounded-xl hover:bg-white/5 cursor-pointer group transition-all border border-transparent hover:border-white/10"
          >
            <div className="flex items-center gap-4 min-w-0">
              <div className="h-9 w-9 rounded-xl bg-white/5 flex items-center justify-center text-text-muted group-hover:text-accent-indigo group-hover:bg-accent-indigo/10 shrink-0 transition-colors">
                {getJobIcon(job.name)}
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-text-primary truncate transition-colors">{job.name}</p>
                <p className="text-[11px] text-text-muted font-mono mt-0.5">{job.id.substring(0, 8)}</p>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1.5 shrink-0 ml-3">
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border uppercase tracking-[0.08em] ${STATUS_CHIP[job.status] ?? STATUS_CHIP.PENDING}`}>
                {job.status.replace('_', ' ')}
              </span>
              <span className="text-[11px] text-text-muted">{timeAgo(job.createdAt)}</span>
            </div>
          </div>
        ))}
      </div>
      
      <button onClick={() => navigate('/jobs')} className="mt-4 pt-3.5 border-t border-border text-[12px] font-medium text-accent-indigo hover:text-indigo-400 flex items-center justify-center gap-1.5 transition-colors w-full group">
        View all jobs <ArrowUpRight size={16} className="group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
      </button>
    </div>
  );
};
