import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, RotateCcw, Trash2 } from 'lucide-react';
import { Job } from '../../services/jobsService';
import { cn } from '../../utils/cn';

interface JobDrawerProps {
  job: Job | null;
  isOpen: boolean;
  onClose: () => void;
  onReplay: (id: string) => Promise<void>;
  onDiscard: (id: string) => Promise<void>;
  onRetry?: (id: string) => Promise<void>;
}

const statusStyles: Record<string, string> = {
  'PROCESSING': 'bg-accent-blue/10 text-accent-blue border-accent-blue/20',
  'COMPLETED': 'bg-accent-green/10 text-accent-green border-accent-green/20',
  'FAILED': 'bg-accent-red/10 text-accent-red border-accent-red/20',
  'DEAD_LETTER': 'bg-accent-red/10 text-accent-red border-accent-red/20',
  'PENDING': 'bg-accent-yellow/10 text-accent-yellow border-accent-yellow/20',
  'DELAYED': 'bg-accent-purple/10 text-accent-purple border-accent-purple/20',
};

export const JobDrawer: React.FC<JobDrawerProps> = ({ job, isOpen, onClose, onReplay, onDiscard, onRetry }) => {
  if (!job) return null;

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }} 
            onClick={onClose}
            className="absolute inset-0 bg-black/40 backdrop-blur-sm" 
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="relative w-full max-w-md bg-background-panel border-l border-white/10 h-full shadow-2xl flex flex-col"
          >
            <div className="flex justify-between items-start p-6 border-b border-white/10 bg-white/[0.02]">
              <div>
                <h2 className="text-lg font-semibold text-text-primary break-all pr-4">{job.name}</h2>
                <div className="text-sm text-text-muted font-mono mt-1">{job.id}</div>
              </div>
              <button onClick={onClose} className="text-text-muted hover:text-text-primary p-1 bg-white/5 rounded transition-colors flex-shrink-0">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">
              
              <div className="flex items-center justify-between bg-white/5 p-4 rounded-lg border border-white/10">
                <div>
                  <div className="text-xs text-text-muted mb-1">Status</div>
                  <span className={cn("text-[11px] font-bold px-2.5 py-1 rounded-full border tracking-wide", statusStyles[job.status] || statusStyles['PENDING'])}>
                    {job.status}
                  </span>
                </div>
                <div className="text-right">
                  <div className="text-xs text-text-muted mb-1">Attempts</div>
                  <div className="text-sm font-medium text-text-primary">{job.attempts} / {job.maxAttempts}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-text-muted mb-1">Priority</div>
                  <div className="text-sm font-medium text-text-primary">{job.priority}</div>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-medium text-text-primary mb-2">Payload</h3>
                <pre className="bg-background-main p-4 rounded-lg border border-white/10 text-xs text-text-primary font-mono overflow-x-auto">
                  {JSON.stringify(job.payload, null, 2)}
                </pre>
              </div>

              {job.errorLog && (
                <div>
                  <h3 className="text-sm font-medium text-accent-red mb-2 flex items-center gap-2">Error Log</h3>
                  <div className="bg-accent-red/5 p-4 rounded-lg border border-accent-red/20 text-xs text-accent-red/90 font-mono whitespace-pre-wrap overflow-x-auto">
                    {job.errorLog.message || JSON.stringify(job.errorLog)}
                  </div>
                </div>
              )}
            </div>

            {job.status === 'DEAD_LETTER' && (
              <div className="p-4 border-t border-white/10 bg-white/[0.02] flex gap-3">
                <button 
                  onClick={() => onReplay(job.id)}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-accent-indigo hover:bg-indigo-500 text-white text-sm font-medium rounded-md transition-colors shadow-lg"
                >
                  <RotateCcw className="h-4 w-4" /> Replay Job
                </button>
                <button 
                  onClick={() => onDiscard(job.id)}
                  className="flex items-center justify-center gap-2 px-4 py-2.5 bg-accent-red/10 hover:bg-accent-red/20 text-accent-red border border-accent-red/20 text-sm font-medium rounded-md transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            )}
            {job.status === 'FAILED' && onRetry && (
              <div className="p-4 border-t border-white/10 bg-white/[0.02] flex gap-3">
                <button 
                  onClick={() => onRetry(job.id)}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-accent-red/10 hover:bg-accent-red/20 text-accent-red border border-accent-red/20 text-sm font-medium rounded-md transition-colors shadow-lg"
                >
                  <RotateCcw className="h-4 w-4" /> Retry Job
                </button>
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
