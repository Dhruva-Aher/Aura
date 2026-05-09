import React from 'react';
import { motion } from 'framer-motion';
import { Server, Activity, CheckCircle, AlertOctagon, TrendingUp, TrendingDown } from 'lucide-react';
import { ResponsiveContainer, LineChart, Line } from 'recharts';
import { useAura } from '../../AuraContext';

const sparklineData = (trend: 'up' | 'down' | 'flat') => {
  return Array.from({ length: 15 }, (_, i) => ({
    value: trend === 'up' ? 20 + i * 2 : trend === 'down' ? 40 - i * 1.5 : 30
  }));
};

interface KpiCardProps {
  title: string;
  value: string;
  change?: number;
  icon: React.ReactNode;
  iconColorClass: string;
  trend?: 'up' | 'down' | 'flat';
  sparklineColor: string;
}

const KpiCard: React.FC<KpiCardProps> = ({ title, value, change, icon, iconColorClass, trend, sparklineColor }) => {
  const normalizedTrend = trend ?? 'flat';
  const hasChange = typeof change === 'number';
  const isPositive = (change ?? 0) > 0;
  
  return (
    <motion.div whileHover={{ y: -2 }} className="panel p-5 flex flex-col justify-between h-[140px]">
      <div className="flex justify-between items-start">
        <div>
          <h3 className="text-text-muted text-sm font-medium mb-1">{title}</h3>
          <div className="text-3xl font-bold text-white tracking-tight">{value}</div>
        </div>
        <div className={`p-2 rounded-lg bg-white/5 border border-white/10 ${iconColorClass}`}>
          {icon}
        </div>
      </div>
      
      <div className="flex items-end justify-between mt-4">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          {hasChange ? (
            <>
              <span className={isPositive ? "text-status-completed flex items-center gap-0.5" : "text-status-failed flex items-center gap-0.5"}>
                {isPositive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                {Math.abs(change ?? 0)}%
              </span>
              <span className="text-text-muted">vs previous hour</span>
            </>
          ) : (
            <span className="text-text-muted">Live count</span>
          )}
        </div>
        
        <div className="w-24 h-8 opacity-70">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={sparklineData(normalizedTrend)}>
              <Line type="monotone" dataKey="value" stroke={sparklineColor} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </motion.div>
  );
};

export const KpiRow: React.FC = () => {
  const { metrics } = useAura();

  if (!metrics) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-6">
        {[1,2,3,4].map(i => <div key={i} className="panel p-5 h-[140px] animate-pulse bg-white/5" />)}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-6">
      <KpiCard 
        title="Pending" 
        value={metrics.active.value.toLocaleString()} 
        change={metrics.active.change} 
        icon={<Server className="h-5 w-5" />}
        iconColorClass="text-accent"
        trend={metrics.active.trend}
        sparklineColor="#5A67D8"
      />
      <KpiCard 
        title="Processing" 
        value={metrics.processing.value.toLocaleString()} 
        change={metrics.processing.change} 
        icon={<Activity className="h-5 w-5" />}
        iconColorClass="text-status-processing"
        trend={metrics.processing.trend}
        sparklineColor="#3B82F6"
      />
      <KpiCard 
        title="Completed" 
        value={metrics.completed.value.toLocaleString()} 
        change={metrics.completed.change} 
        icon={<CheckCircle className="h-5 w-5" />}
        iconColorClass="text-status-completed"
        trend={metrics.completed.trend}
        sparklineColor="#22C55E"
      />
      <KpiCard 
        title="Dead Letters" 
        value={metrics.failed.value.toLocaleString()} 
        change={metrics.failed.change} 
        icon={<AlertOctagon className="h-5 w-5" />}
        iconColorClass="text-status-failed"
        trend={metrics.failed.trend}
        sparklineColor="#EF4444"
      />
    </div>
  );
};
