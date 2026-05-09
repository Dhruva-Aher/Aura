import React from 'react';
import { CheckCircle2, ArrowUpRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { SystemHealth } from '../../services/systemService';

export const SystemHealthPanel: React.FC<{ health: SystemHealth[] }> = ({ health }) => {
  const navigate = useNavigate();
  const allOk = health.every(h => h.state === 'ok');

  return (
    <div className="panel p-5 flex flex-col h-full">
      <div className="flex items-center justify-between mb-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">System Health</p>
        {allOk ? (
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-accent-green">
            <CheckCircle2 size={14} /> Operational
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-accent-red">
            <div className="h-2 w-2 rounded-full bg-accent-red animate-pulse" /> Issues Detected
          </span>
        )}
      </div>
      
      <div className="flex-1 space-y-3">
        {health.map((s, i) => (
          <div key={i} className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`h-2 w-2 rounded-full ${s.state === 'ok' ? 'bg-accent-green shadow-[0_0_8px_rgba(34,197,94,0.4)]' : 'bg-accent-red shadow-[0_0_8px_rgba(239,68,68,0.4)]'}`} />
              <span className="text-[13px] font-medium text-text-primary">{s.name}</span>
            </div>
            <span className="text-[11px] font-mono font-medium text-text-muted">{s.ms}</span>
          </div>
        ))}
      </div>
      
      <button onClick={() => navigate('/system-health')} className="mt-4 pt-3.5 border-t border-border text-[12px] font-medium text-accent-indigo hover:text-indigo-400 flex items-center justify-center gap-1.5 transition-colors w-full group">
        View detailed health <ArrowUpRight size={16} className="group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
      </button>
    </div>
  );
};
