import React from 'react';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer } from 'recharts';
import { HelpCircle } from 'lucide-react';

export const ThroughputChart: React.FC<{ value: number; change: number; data: any[] }> = ({ value, change, data }) => {
  const increasing = change >= 0;
  return (
    <div className="panel p-5 flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">Throughput</p>
          <HelpCircle size={14} className="text-text-muted cursor-help" />
        </div>
        <span className="text-[11px] font-medium text-text-secondary bg-white/5 border border-white/10 rounded px-2.5 py-1">
          Jobs/min ▾
        </span>
      </div>
      
      <div className="mt-3 mb-2 flex items-baseline gap-3">
        <span className="text-[30px] font-bold text-text-primary leading-none">{value.toLocaleString()}</span>
        <span className={`text-xs font-semibold ${increasing ? 'text-accent-green' : 'text-accent-red'}`}>
          {increasing ? '↑' : '↓'} {Math.abs(change)}%
        </span>
      </div>
      
      <p className="text-[11px] text-text-muted mb-4 font-medium">Average per minute</p>
      
      <div className="flex-1 min-h-[100px] mt-auto">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 10, right: 0, left: -30, bottom: 0 }} barSize={8}>
            <YAxis stroke="#6B7280" fontSize={10} tickLine={false} axisLine={false} tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(1)}k` : String(v)} ticks={[0, 750, 1500]} domain={[0, 1600]} />
            <XAxis dataKey="time" stroke="#6B7280" fontSize={10} tickLine={false} axisLine={false} dy={8} minTickGap={40} />
            <Bar dataKey="completed" fill="#6366F1" opacity={0.8} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
