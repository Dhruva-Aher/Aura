import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Play, RotateCcw, ChevronRight } from 'lucide-react';
import { LineChart, Line, ResponsiveContainer } from 'recharts';
import { useAura } from '../../AuraContext';
import { EnqueueJobModal } from '../modals/EnqueueJobModal';
import { ConfirmActionDialog } from '../modals/ConfirmActionDialog';

const genSparkline = () => Array.from({ length: 10 }, () => ({ val: 10 + Math.random() * 20 }));

const ActiveWorkersTable: React.FC = () => {
  const { workers } = useAura();
  
  if (!workers) {
    return <div className="panel col-span-3 min-h-[250px] animate-pulse bg-white/5" />;
  }
  
  return (
    <div className="panel col-span-3 flex flex-col min-h-[250px]">
      <div className="flex justify-between items-center p-5 border-b border-border">
        <div className="flex items-center gap-3">
          <h2 className="text-white font-semibold">Active Workers</h2>
          <span className="text-status-completed text-xs font-medium bg-status-completed/10 px-2 py-0.5 rounded-full border border-status-completed/20">
            {workers.filter(w => w.status === 'ONLINE').length} online
          </span>
        </div>
      </div>
      
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="text-xs text-text-muted bg-white/[0.02]">
            <tr>
              <th className="px-5 py-3 font-medium">Worker ID</th>
              <th className="px-5 py-3 font-medium">Pool</th>
              <th className="px-5 py-3 font-medium">Current Job</th>
              <th className="px-5 py-3 font-medium w-24">CPU</th>
              <th className="px-5 py-3 font-medium w-24">Memory</th>
              <th className="px-5 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {workers.map(worker => (
              <tr key={worker.id} className="hover:bg-white/[0.02] transition-colors group">
                <td className="px-5 py-3 font-mono text-text-main">{worker.id}</td>
                <td className="px-5 py-3 text-text-muted">{worker.pool}</td>
                <td className="px-5 py-3">
                  <div className="flex gap-1">
                    <span className="text-accent hover:underline cursor-pointer transition-colors">
                      {worker.currentJobId ? 'Processing' : 'Idle'}
                    </span>
                    {worker.currentJobId && <span className="text-text-muted font-mono">({worker.currentJobId.substring(0,8)})</span>}
                  </div>
                </td>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <span className="text-text-main w-8">{worker.cpu}%</span>
                    <div className="h-4 w-12 opacity-60">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={genSparkline()}><Line type="monotone" dataKey="val" stroke="#5A67D8" strokeWidth={1.5} dot={false} /></LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </td>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <span className="text-text-main w-12">{worker.memory}</span>
                    <div className="h-4 w-12 opacity-60">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={genSparkline()}><Line type="monotone" dataKey="val" stroke="#3B82F6" strokeWidth={1.5} dot={false} /></LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </td>
                <td className="px-5 py-3">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider border ${worker.status === 'ONLINE' ? 'bg-status-completed/10 text-status-completed border-status-completed/20' : 'bg-text-muted/10 text-text-muted border-text-muted/20'}`}>
                    {worker.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const QuickActionsPanel: React.FC = () => {
  const { enqueueJob, recentJobs, replayDlq } = useAura();
  const [isEnqueueOpen, setIsEnqueueOpen] = useState(false);
  const [isReplayOpen, setIsReplayOpen] = useState(false);

  const handleReplay = () => {
    const dlqJob = recentJobs?.find(j => j.status === 'DEAD_LETTER');
    if (dlqJob) replayDlq(dlqJob.id);
  };

  return (
    <>
      <div className="panel col-span-1 p-5 flex flex-col">
        <h2 className="text-white font-semibold mb-4">Quick Actions</h2>
        <div className="flex-1 flex flex-col gap-2">
          <button onClick={() => setIsEnqueueOpen(true)} className="flex items-center justify-between w-full p-3 rounded-lg bg-white/[0.03] border border-border hover:bg-white/[0.06] hover:border-white/10 transition-all group">
            <div className="flex items-center gap-3">
              <div className="text-text-muted group-hover:text-accent transition-colors"><Play className="h-5 w-5" /></div>
              <span className="text-sm font-medium text-text-main">Enqueue a Job</span>
            </div>
            <ChevronRight className="h-4 w-4 text-text-muted group-hover:text-white transition-colors" />
          </button>

          <button onClick={() => setIsReplayOpen(true)} className="flex items-center justify-between w-full p-3 rounded-lg bg-white/[0.03] border border-border hover:bg-white/[0.06] hover:border-white/10 transition-all group">
            <div className="flex items-center gap-3">
              <div className="text-text-muted group-hover:text-accent transition-colors"><RotateCcw className="h-5 w-5" /></div>
              <span className="text-sm font-medium text-text-main">Replay Dead Letter</span>
            </div>
            <ChevronRight className="h-4 w-4 text-text-muted group-hover:text-white transition-colors" />
          </button>
        </div>
      </div>
      
      <EnqueueJobModal isOpen={isEnqueueOpen} onClose={() => setIsEnqueueOpen(false)} onEnqueue={enqueueJob} />
      
      <ConfirmActionDialog 
        isOpen={isReplayOpen} 
        title="Replay Dead Letter Queue" 
        message="Are you sure you want to replay the most recent failed job from the Dead Letter Queue?"
        confirmText="Replay Job"
        onClose={() => setIsReplayOpen(false)} 
        onConfirm={handleReplay} 
      />
    </>
  );
};

export const BottomPanels: React.FC = () => {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.6 }} className="grid grid-cols-1 lg:grid-cols-4 gap-6 pb-8">
      <ActiveWorkersTable />
      <QuickActionsPanel />
    </motion.div>
  );
};
