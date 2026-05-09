import React from 'react';
import { motion } from 'framer-motion';
import { PieChart, Pie, Cell, BarChart, Bar, ResponsiveContainer, LineChart, Line, YAxis } from 'recharts';
import { CheckCircle } from 'lucide-react';
import { cn } from '../../utils/cn';
import { useAura } from '../../AuraContext';

const QueueDepth: React.FC = () => {
  const { metrics } = useAura();
  
  if (!metrics) {
    return <div className="panel h-[280px] animate-pulse bg-white/5" />;
  }

  const data = [
    { name: 'Pending', value: metrics.active.value, color: '#5A67D8' },
    { name: 'Processing', value: metrics.processing.value, color: '#3B82F6' },
    { name: 'Delayed', value: metrics.delayed.value, color: '#A78BFA' },
    { name: 'Completed', value: metrics.completed.value, color: '#22C55E' },
    { name: 'Failed', value: metrics.failed.value, color: '#EF4444' },
  ];
  
  const total = data.reduce((acc, curr) => acc + curr.value, 0);

  return (
    <div className="panel p-5 flex flex-col h-[280px]">
      <h3 className="text-white font-semibold mb-4">Queue Depth by State</h3>
      <div className="flex items-center justify-between flex-1">
        <div className="relative w-[120px] h-[120px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} innerRadius={45} outerRadius={60} paddingAngle={2} dataKey="value" stroke="none">
                {data.map((entry, index) => <Cell key={`cell-${index}`} fill={entry.color} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-lg font-bold text-white leading-tight">{total.toLocaleString()}</span>
            <span className="text-[10px] text-text-muted">Total</span>
          </div>
        </div>
        <div className="flex-1 ml-6 space-y-2">
          {data.map(item => (
            <div key={item.name} className="flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }} />
                <span className="text-text-muted">{item.name}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-white font-medium">{item.value.toLocaleString()}</span>
                <span className="text-text-muted opacity-60 w-8 text-right">
                  {total > 0 ? ((item.value / total) * 100).toFixed(1) : '0'}%
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const JobLatency: React.FC = () => {
  const latencyData = Array.from({ length: 15 }, (_, i) => ({ time: i, value: 2 + Math.random() * 1.5 }));
  return (
    <div className="panel p-5 flex flex-col h-[280px]">
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-white font-semibold flex items-center gap-2">
          Job Latency <span className="text-text-muted text-xs font-normal">(Queue Wait Time)</span>
        </h3>
      </div>
      <div className="flex items-end gap-3 mb-1">
        <span className="text-3xl font-bold text-white tracking-tight">2.34s</span>
        <span className="text-status-completed text-xs font-medium flex items-center mb-1">↓ 4.2%</span>
      </div>
      <div className="text-xs text-text-muted mb-4">95th percentile</div>
      <div className="flex-1 w-full min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={latencyData}>
            <Line type="monotone" dataKey="value" stroke="#5A67D8" strokeWidth={2} dot={{ r: 3, fill: '#5A67D8', strokeWidth: 0 }} />
            <YAxis domain={[0, 4]} hide />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

const Throughput: React.FC = () => {
  const throughputData = Array.from({ length: 30 }, (_, i) => ({ time: i, value: 500 + Math.random() * 800 }));
  return (
    <div className="panel p-5 flex flex-col h-[280px]">
      <div className="flex justify-between items-center mb-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-white font-semibold">Throughput</h3>
        </div>
      </div>
      <div className="flex items-end gap-3 mb-1">
        <span className="text-3xl font-bold text-white tracking-tight">892</span>
        <span className="text-status-completed text-xs font-medium flex items-center mb-1">↑ 9.7%</span>
      </div>
      <div className="text-xs text-text-muted mb-4">Average per minute</div>
      <div className="flex-1 w-full min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={throughputData}>
            <Bar dataKey="value" fill="#5A67D8" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

const SystemHealthList: React.FC = () => {
  const { health } = useAura();
  
  if (!health) {
    return <div className="panel h-[280px] animate-pulse bg-white/5" />;
  }
  
  return (
    <div className="panel p-5 flex flex-col h-[280px]">
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-white font-semibold">System Health</h3>
        <span className="text-status-completed text-xs flex items-center gap-1 font-medium">
          <CheckCircle className="h-3 w-3" /> Operational
        </span>
      </div>
      <div className="flex-1 space-y-4">
        {health.map(sys => (
          <div key={sys.name} className="flex justify-between items-center text-sm">
            <div className="flex items-center gap-3">
              <div className={cn("w-2 h-2 rounded-full", sys.state === 'ok' ? "bg-status-completed shadow-[0_0_8px_#22C55E]" : "bg-status-failed")} />
              <span className="text-text-main font-medium">{sys.name}</span>
            </div>
            <span className="text-text-muted text-xs font-mono">{sys.ms}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export const SecondaryMetrics: React.FC = () => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 mb-6">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.2 }}>
        <QueueDepth />
      </motion.div>
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.3 }}>
        <JobLatency />
      </motion.div>
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.4 }}>
        <Throughput />
      </motion.div>
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.5 }}>
        <SystemHealthList />
      </motion.div>
    </div>
  );
};
