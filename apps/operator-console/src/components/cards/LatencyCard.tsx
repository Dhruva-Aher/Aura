import React from 'react';
import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer } from 'recharts';
import { HelpCircle } from 'lucide-react';

export const LatencyCard: React.FC<{ value: number; change: number; data: any[] }> = ({ value, change, data }) => {
  const improving = change <= 0;
  return (
    <div className="panel p-5 flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">Job Latency</p>
          <HelpCircle size={14} className="text-text-muted cursor-help" />
        </div>
        <span className="text-[11px] font-medium text-text-secondary bg-white/5 border border-white/10 rounded px-2.5 py-1">
          P95 ▾
        </span>
      </div>
      
      <div className="mt-3 mb-2 flex items-baseline gap-3">
        <span className="text-[30px] font-bold text-text-primary leading-none">{value.toFixed(2)}s</span>
        <span className={`text-xs font-semibold ${improving ? 'text-accent-green' : 'text-accent-red'}`}>
          {improving ? '↓' : '↑'} {Math.abs(change)}%
        </span>
      </div>
      
      <p className="text-[11px] text-text-muted mb-4 font-medium">95th percentile queue wait time</p>
      
      <div className="flex-1 min-h-[100px] mt-auto">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 10, right: 0, left: -30, bottom: 0 }}>
            <defs>
              <linearGradient id="latGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366F1" stopOpacity={0.4} />
                <stop offset="95%" stopColor="#6366F1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis stroke="#6B7280" fontSize={10} tickLine={false} axisLine={false} tickFormatter={v => `${v.toFixed(0)}s`} ticks={[0, 2, 4]} domain={[0, 5]} />
            <XAxis dataKey="time" stroke="#6B7280" fontSize={10} tickLine={false} axisLine={false} dy={8} minTickGap={40} />
            <Area type="monotone" dataKey="v" stroke="#6366F1" fill="url(#latGrad)" strokeWidth={2} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
