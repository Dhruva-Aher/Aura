import React from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { HelpCircle, ChevronRight, ArrowUpRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PulsePoint } from '../../services/metricsService';

export const PulseLineChart: React.FC<{ data: PulsePoint[] }> = ({ data }) => {
  const navigate = useNavigate();

  return (
    <div className="panel p-5 flex flex-col h-full">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-text-primary text-[20px]">The Pulse Line</h3>
          <HelpCircle size={14} className="text-text-muted cursor-help" />
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[11px] text-text-secondary bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5">
            Jobs/sec <ChevronRight size={14} className="rotate-90 text-text-muted" />
          </span>
          <button onClick={() => navigate('/metrics-view')} className="flex items-center gap-1.5 text-[11px] text-accent-indigo bg-accent-indigo/10 border border-accent-indigo/20 rounded-lg px-2.5 py-1.5 hover:bg-accent-indigo/20 transition-colors">
            View full metrics <ArrowUpRight size={14} />
          </button>
        </div>
      </div>
      
      <div className="flex-1 min-h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="pulseGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366F1" stopOpacity={0.4} />
                <stop offset="95%" stopColor="#6366F1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
            <XAxis dataKey="time" stroke="#6B7280" fontSize={12} tickLine={false} axisLine={false} dy={12} minTickGap={40} />
            <YAxis stroke="#6B7280" fontSize={12} tickLine={false} axisLine={false} dx={-10} />
            <Tooltip contentStyle={{ background: '#111827', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, color: '#E5E7EB', fontSize: 12, boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.5)' }} />
            <Area type="monotone" dataKey="completed" stroke="#6366F1" fill="url(#pulseGrad)" strokeWidth={3} dot={false} activeDot={{ r: 6, fill: '#6366F1', stroke: '#111827', strokeWidth: 2 }} isAnimationActive={false} />
            <Area type="monotone" dataKey="failed" stroke="#EF4444" fill="transparent" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Area type="monotone" dataKey="scheduled" stroke="#3B82F6" fill="transparent" strokeWidth={2} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="flex items-center gap-6 mt-4 justify-center">
        {[
          { color: '#22C55E', label: 'Completed' },
          { color: '#EF4444', label: 'Failed' },
          { color: '#3B82F6', label: 'Scheduled' }
        ].map(({ color, label }) => (
          <span key={label} className="flex items-center gap-2 text-[11px] font-medium text-text-secondary">
            <div className="h-2.5 w-2.5 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: color, color }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
};
