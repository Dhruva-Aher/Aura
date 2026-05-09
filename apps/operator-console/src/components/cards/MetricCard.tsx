import React from 'react';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';

export const MetricCard: React.FC<{
  label: string;
  value: number;
  change?: number;
  trend?: 'up' | 'down' | 'flat';
  icon: React.ReactNode;
  iconColor: string;
  sparkData: number[];
  sparkColor: string;
  gradId: string;
}> = ({ label, value, change, trend, icon, iconColor, sparkData, sparkColor, gradId }) => {
  const hasChange = typeof change === 'number';
  const up = trend === 'up';
  const down = trend === 'down';
  const pts = sparkData.map((v, i) => ({ i, v }));

  return (
    <div className="panel p-5 flex flex-col justify-between group">
      <div>
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.16em] text-text-muted font-semibold">{label}</p>
            <p className="text-[34px] font-bold text-text-primary mt-2 leading-none transition-transform origin-left group-hover:scale-[1.03]">
              {value.toLocaleString()}
            </p>
          </div>
          <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 shadow-lg ${iconColor}`}>
            {icon}
          </div>
        </div>
        <div className="flex items-center gap-2 mb-3.5">
          {hasChange ? (
            <>
              <span className={`text-xs font-semibold ${up ? 'text-accent-green' : down ? 'text-accent-red' : 'text-text-secondary'}`}>
                {up ? '↑' : down ? '↓' : '→'} {Math.abs(change!)}%
              </span>
              <span className="text-[11px] text-text-muted">vs previous hour</span>
            </>
          ) : (
            <span className="text-[11px] text-text-muted">Live count</span>
          )}
        </div>
      </div>
      <div className="h-12 mt-auto">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={pts} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={sparkColor} stopOpacity={0.4} />
                <stop offset="95%" stopColor={sparkColor} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area 
              type="monotone" 
              dataKey="v" 
              stroke={sparkColor} 
              fill={`url(#${gradId})`} 
              strokeWidth={2} 
              dot={false} 
              isAnimationActive={false} 
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
