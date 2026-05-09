import React from 'react';
import { Zap, RefreshCcw, BarChart3, Calendar, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export const QuickActionsPanel: React.FC<{ onEnqueue: () => void }> = ({ onEnqueue }) => {
  const navigate = useNavigate();

  return (
    <div className="panel p-5 flex flex-col h-full">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted mb-4">Quick Actions</p>
      
      <div className="space-y-2 flex-1 flex flex-col justify-center">
        <QAction icon={<Zap size={18} />} label="Enqueue a Job" onClick={onEnqueue} />
        <QAction icon={<RefreshCcw size={18} />} label="Replay Dead Letter" onClick={() => navigate('/dlq')} />
        <QAction icon={<BarChart3 size={18} />} label="View Metrics" onClick={() => navigate('/metrics-view')} />
        <QAction icon={<Calendar size={18} />} label="View Workers" onClick={() => navigate('/workers')} />
      </div>
    </div>
  );
};

function QAction({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full flex items-center justify-between px-3.5 py-3 rounded-xl bg-white/[0.02] hover:bg-white/5 border border-white/5 hover:border-white/10 text-text-secondary hover:text-text-primary transition-all group">
      <div className="flex items-center gap-3">
        <div className="text-accent-indigo group-hover:text-indigo-400 group-hover:scale-110 transition-all duration-300">
          {icon}
        </div>
        <span className="text-[13px] font-semibold">{label}</span>
      </div>
      <ChevronRight size={16} className="text-text-muted group-hover:text-text-primary group-hover:translate-x-1 transition-all" />
    </button>
  );
}
