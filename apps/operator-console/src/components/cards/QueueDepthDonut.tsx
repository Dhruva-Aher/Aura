import React from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';

export const QueueDepthDonut: React.FC<{
  totalActive: number;
  data: { v: number; color: string }[];
  legend: { label: string; value: number; pct: string; color: string }[];
}> = ({ totalActive, data, legend }) => {
  return (
    <div className="panel p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted mb-5">Queue Depth by State</p>
      
      <div className="flex items-center gap-5">
        <div className="relative shrink-0" style={{ width: 112, height: 112 }}>
          <div className="absolute inset-0 flex flex-col items-center justify-center z-10">
            <span className="text-[22px] font-bold text-text-primary leading-none">{totalActive.toLocaleString()}</span>
            <span className="text-[10px] text-text-muted mt-1 uppercase tracking-[0.12em] font-semibold">Total</span>
          </div>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} innerRadius={40} outerRadius={56} paddingAngle={3} dataKey="v" isAnimationActive={false} startAngle={90} endAngle={-270}>
                {data.map((e, i) => <Cell key={i} fill={e.color} stroke="none" />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>
        
        <div className="space-y-2.5 flex-1">
          {legend.map((l, i) => (
            <div key={i} className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full shrink-0" style={{ background: l.color }} />
                <span className="text-[12px] font-medium text-text-secondary">{l.label}</span>
              </div>
              <span className="text-[12px] text-text-primary font-mono font-medium">
                {l.value.toLocaleString()} <span className="text-text-muted">({l.pct}%)</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
