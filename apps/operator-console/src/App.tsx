import React, { useState, useEffect } from 'react';
import { Routes, Route, NavLink, useNavigate } from 'react-router-dom';
import { 
  Zap, 
  Search, MoonStar, ChevronRight, 
  Server, Database, LayoutDashboard, ListFilter,
  Plus, CalendarDays, Workflow, Gauge,
  ShieldCheck, FolderKanban, ChevronDown,
  TriangleAlert, Repeat
} from 'lucide-react';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, 
  ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, Line, ComposedChart
} from 'recharts';
import { useAura } from './AuraContext';
import { EnqueueJobModal } from './components/modals/EnqueueJobModal';
import { JobDrawer } from './components/modals/JobDrawer';
import { Job, jobsService } from './services/jobsService';
import { useInfiniteQuery } from '@tanstack/react-query';

const sidebarGroups = [
  {
    title: "",
    items: [
      { label: "Overview", icon: LayoutDashboard, to: "/" },
    ],
  },
  {
    title: "Jobs",
    items: [
      { label: "Jobs", icon: ListFilter, to: "/jobs" },
      { label: "Enqueue Job", icon: Plus, to: "#", isAction: true },
      { label: "Dead Letter Queue", icon: TriangleAlert, to: "/dlq" },
      { label: "Schedules", icon: CalendarDays, to: "/schedules" },
    ],
  },
  {
    title: "Workers",
    items: [
      { label: "Workers", icon: Workflow, to: "/workers" },
      
    ],
  },
  {
    title: "Monitoring",
    items: [
      { label: "Metrics", icon: Gauge, to: "/metrics" },
      
      { label: "System Health", icon: ShieldCheck, to: "/health" },
    ],
  },
  
];

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

export default function App() {
  const [isEnqueueOpen, setIsEnqueueOpen] = useState(false);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [isDark, setIsDark] = useState(true);
  return (
    <div className="min-h-screen bg-[#070912] text-white font-sans selection:bg-violet-500/30">
      <div className="flex h-screen">
        
        {/* Sidebar */}
        <aside className="hidden w-[280px] shrink-0 border-r border-white/10 bg-[#060811] px-4 py-4 xl:flex xl:flex-col">
          <div className="flex items-center gap-3 px-2 py-3">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-violet-500/15 text-violet-300 ring-1 ring-violet-500/20">
              <Zap className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-[0.18em] text-white">AURA CONSOLE</div>
            </div>
            <button className="ml-auto grid h-9 w-9 place-items-center rounded-xl text-white/55 hover:bg-white/5 hover:text-white">
              <ListFilter className="h-5 w-5" />
            </button>
          </div>

          <div className="mt-3 space-y-5 overflow-y-auto pr-1 custom-scrollbar">
            {sidebarGroups.map((group) => (
              <div key={group.title}>
                {group.title ? <div className="mb-3 px-2 text-xs font-medium uppercase tracking-[0.2em] text-white/35">{group.title}</div> : null}
                <div className="space-y-1">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    if (item.isAction) {
                      return (
                        <button
                          key={item.label}
                          onClick={() => setIsEnqueueOpen(true)}
                          className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition text-white/72 hover:bg-white/5 hover:text-white"
                        >
                          <Icon className="h-4 w-4 shrink-0" />
                          <span>{item.label}</span>
                        </button>
                      );
                    }
                    return (
                      <NavLink
                        key={item.label}
                        to={item.to}
                        end={item.to === '/'}
                        className={({ isActive }) => 
                          `flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
                            isActive 
                              ? "bg-violet-500/15 text-violet-200 ring-1 ring-violet-500/20" 
                              : "text-white/72 hover:bg-white/5 hover:text-white"
                          }`
                        }
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span>{item.label}</span>
                      </NavLink>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-auto rounded-2xl border border-white/10 bg-[#0d1020] p-3 shrink-0">
            <div className="flex items-center gap-3 flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-full bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/20 transition group-hover:bg-sky-500/30">AD</div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-white group-hover:text-sky-300 transition">Admin</div>
                <div className="truncate text-xs text-white/45">admin@aura.dev</div>
              </div>
              
            </div>
          </div>
        </aside>

        {/* Main */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Top bar */}
          <header className="px-4 py-4 lg:px-6 xl:px-8 border-b border-transparent shrink-0">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3 xl:hidden">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-violet-500/15 text-violet-300 ring-1 ring-violet-500/20">
                  <Zap className="h-5 w-5" />
                </div>
                <div className="text-sm font-semibold tracking-[0.18em] text-white">AURA CONSOLE</div>
              </div>

              <div className="ml-auto flex w-full max-w-[700px] items-center gap-3 xl:w-auto">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-11 w-full rounded-2xl border border-white/10 bg-[#111528] pl-10 pr-24 text-sm text-white placeholder:text-white/30 outline-none transition focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20"
                    placeholder="Search jobs, workers, queues..."
                  />
                  <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-semibold text-white/55">⌘ K</div>
                </div>
                <button onClick={() => setIsDark(!isDark)} className={`grid h-11 w-11 place-items-center rounded-full border border-white/10 ${isDark ? 'bg-[#111528] text-white/70 hover:text-white' : 'bg-white/10 text-white'} transition`}>
                  <MoonStar className="h-5 w-5" />
                </button>
                

                <button onClick={() => setIsEnqueueOpen(true)} className="hidden h-11 items-center gap-2 rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-500 px-4 text-sm font-semibold text-white shadow-lg shadow-violet-950/30 hover:brightness-110 sm:flex transition-all active:scale-95">
                  <Plus className="h-4 w-4" /> Enqueue Job
                </button>
              </div>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto px-4 pb-8 lg:px-6 xl:px-8 custom-scrollbar">
            <div className="max-w-[1600px] mx-auto w-full">
              <Routes>
                <Route path="/" element={<DashboardView />} />
                <Route path="/jobs" element={<JobsView search={debouncedSearch} />} />
                <Route path="/dlq" element={<DlqView />} />
                <Route path="/workers" element={<WorkersView />} />
                <Route path="/schedules" element={<SchedulesView />} />
                <Route path="/health" element={<HealthView />} />
                <Route path="/metrics" element={<MetricsView />} />
                
              </Routes>
            </div>
          </div>
        </main>
      </div>

      <EnqueueJobModalWrapper isEnqueueOpen={isEnqueueOpen} setIsEnqueueOpen={setIsEnqueueOpen} />
    </div>
  );
}

// ================= DASHBOARD VIEW =================

function DashboardView() {
  const { metrics, pulse, recentJobs, workers, health, replayDlq, discardDlq, retryJob } = useAura();
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const navigate = useNavigate();

  const queueData = metrics ? [
    { name: "Pending", value: metrics.active.value, color: "#7c6df2" },
    { name: "Processing", value: metrics.processing.value, color: "#4da3ff" },
    { name: "Delayed", value: metrics.delayed.value, color: "#f5b94a" },
    { name: "Completed", value: metrics.completed.value, color: "#5ed08c" },
    { name: "Failed", value: metrics.failed.value, color: "#f45b7a" },
  ] : [];

  const throughputData = pulse ? pulse.map(p => ({ label: p.time, value: p.throughput ?? 0 })) : [];

  const latencyData = pulse ? pulse.map(p => ({ time: p.time, value: p.latency ?? 0 })) : [];

  return (
    <>
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-[2.1rem]">Good evening, Admin 👋</h1>
          <p className="mt-1 text-sm text-white/55">Here's what's happening with your queues.</p>
        </div>
        
      </div>

      {/* Stats row */}
      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard title="Pending" value={metrics?.active.value ?? 0} delta={metrics?.active?.change ? `${metrics.active.change > 0 ? "↗" : "↘"} ${Math.abs(metrics.active.change)}%` : ""} deltaTone={metrics?.active?.change && metrics.active.change > 0 ? "text-rose-300" : "text-emerald-300"} icon={FolderKanban} sparkColor="#7c6df2" sparkData={pulse?.slice(-10).map(p => ({value: p.scheduled})) ?? []} />
        <StatCard title="Processing" value={metrics?.processing.value ?? 0} delta={metrics?.processing?.change ? `${metrics.processing.change > 0 ? "↗" : "↘"} ${Math.abs(metrics.processing.change)}%` : ""} deltaTone={metrics?.processing?.change && metrics.processing.change > 0 ? "text-rose-300" : "text-emerald-300"} icon={Zap} sparkColor="#4da3ff" sparkData={pulse?.slice(-10).map(p => ({value: p.completed})) ?? []} />
        <StatCard title="Completed" value={metrics?.completed.value ?? 0} delta={metrics?.completed?.change ? `${metrics.completed.change >= 0 ? "↗" : "↘"} ${Math.abs(metrics.completed.change)}%` : ""} deltaTone={metrics?.completed?.change && metrics.completed.change >= 0 ? "text-emerald-300" : "text-rose-300"} icon={ShieldCheck} sparkColor="#5ed08c" sparkData={pulse?.slice(-10).map(p => ({value: p.completed})) ?? []} />
        <StatCard title="Dead Letters" value={metrics?.failed.value ?? 0} delta={metrics?.failed?.change ? `${metrics.failed.change > 0 ? "↗" : "↘"} ${Math.abs(metrics.failed.change)}%` : ""} deltaTone={metrics?.failed?.change && metrics.failed.change > 0 ? "text-rose-300" : "text-emerald-300"} icon={TriangleAlert} sparkColor="#f45b7a" sparkData={pulse?.slice(-10).map(p => ({value: p.failed})) ?? []} />
      </div>

      {/* Middle grid */}
      <div className="mt-4 grid gap-4 xl:grid-cols-[1.5fr_0.85fr]">
        <div className="rounded-2xl border border-white/10 bg-[#111528] p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_10px_30px_rgba(0,0,0,0.22)]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <SectionTitle title="The Pulse Line" />
            <div className="flex items-center gap-2">
              
              <button onClick={() => navigate('/metrics')} className="h-10 rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-white/75 hover:text-white transition">View full metrics <ChevronDown className="inline-block h-4 w-4 rotate-[-90deg]" /></button>
            </div>
          </div>
          <div className="h-[280px] w-full">
            {pulse ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={pulse}>
                  <defs>
                    <linearGradient id="pulseFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#7c6df2" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#7c6df2" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="time" tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 12 }} axisLine={false} tickLine={false} width={30} />
                  <Tooltip contentStyle={{ background: "#0f1427", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 16, color: "#fff" }} />
                  <Area type="monotone" dataKey="completed" stroke="#5ed08c" fill="transparent" strokeWidth={2.5} dot={{ r: 2.6, strokeWidth: 0 }} activeDot={{ r: 4 }} isAnimationActive={false} />
                  <Area type="monotone" dataKey="scheduled" stroke="#7c6df2" fill="url(#pulseFill)" strokeWidth={2.5} dot={{ r: 2.6, strokeWidth: 0 }} activeDot={{ r: 4 }} isAnimationActive={false} />
                  <Area type="monotone" dataKey="failed" stroke="#f45b7a" fill="transparent" strokeWidth={2.5} dot={{ r: 2.6, strokeWidth: 0 }} activeDot={{ r: 4 }} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : <div className="h-full w-full animate-pulse bg-white/5 rounded-xl" />}
          </div>
          <div className="mt-2 flex items-center justify-center gap-6 text-xs text-white/60">
            <LegendDot color="#5ed08c" label="Completed" />
            <LegendDot color="#f45b7a" label="Failed" />
            <LegendDot color="#7c6df2" label="Scheduled" />
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#111528] p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_10px_30px_rgba(0,0,0,0.22)] flex flex-col">
          <SectionTitle title="Recent Jobs" action="View all" onAction={() => navigate('/jobs')} />
          <div className="space-y-2 flex-1 overflow-y-auto pr-2 custom-scrollbar">
            {recentJobs ? recentJobs.slice(0, 5).map((job) => (
              <div key={job.id} onClick={() => setSelectedJob(job)} className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-white/5 cursor-pointer transition">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-violet-500/15 text-violet-300">
                  <Database className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-white">{job.name}</div>
                  <div className="text-xs text-white/35 font-mono">{job.id?.substring(0,8) ?? '—'}</div>
                </div>
                <StatusPill status={job.status} />
              </div>
            )) : [1,2,3,4,5].map(i => <div key={i} className="h-14 bg-white/5 rounded-xl animate-pulse" />)}
          </div>
          <button onClick={() => navigate('/jobs')} className="mt-3 w-full rounded-xl border border-white/10 bg-white/5 py-2.5 text-sm text-violet-200 hover:bg-white/10 transition">View all jobs →</button>
        </div>
      </div>

      {/* Lower cards */}
      <div className="mt-4 grid gap-4 xl:grid-cols-[1.1fr_1fr_1fr_1fr]">
        <div className="rounded-2xl border border-white/10 bg-[#111528] p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_10px_30px_rgba(0,0,0,0.22)]">
          <SectionTitle title="Queue Depth by State" />
          <div className="grid grid-cols-[1fr_auto] items-center gap-4">
            <div className="h-[220px] w-full relative">
              {metrics ? (
                <>
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="text-2xl font-bold text-white">{(metrics.active.value + metrics.processing.value + metrics.delayed.value).toLocaleString()}</span>
                    <span className="text-[10px] text-white/50 uppercase">Total</span>
                  </div>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={queueData} innerRadius={64} outerRadius={90} paddingAngle={2} dataKey="value" isAnimationActive={false}>
                        {queueData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                      </Pie>
                      <Tooltip contentStyle={{ background: "#0f1427", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 16, color: "#fff" }} />
                    </PieChart>
                  </ResponsiveContainer>
                </>
              ) : <div className="h-32 w-32 rounded-full border-[12px] border-white/5 animate-pulse mx-auto mt-6" />}
            </div>
            <div className="space-y-2 text-sm">
              {queueData.map((q) => (
                <div key={q.name} className="flex items-center gap-2 text-white/70">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: q.color }} />
                  <span>{q.name}</span>
                  <span className="ml-auto text-white/45">{q.value.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#111528] p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_10px_30px_rgba(0,0,0,0.22)]">
          <div className="mb-3 flex items-center justify-between">
            <SectionTitle title="Job Latency (Queue Wait Time)" />
            
          </div>
          <div className="mb-2 flex items-end gap-3">
            <div className="text-4xl font-semibold">{metrics?.p95Latency ? metrics.p95Latency.toFixed(2) : '0.00'}s</div>
            {metrics?.latencyChange !== undefined && (
              <div className={`rounded-full px-2.5 py-1 text-xs font-semibold ${metrics.latencyChange > 0 ? 'bg-rose-500/15 text-rose-300' : 'bg-emerald-500/15 text-emerald-300'}`}>
                {metrics.latencyChange > 0 ? '↗' : '↘'} {Math.abs(metrics.latencyChange)}%
              </div>
            )}
          </div>
          <div className="text-sm text-white/55">95th percentile</div>
          <div className="mt-3 h-[180px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={latencyData}>
                <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis dataKey="time" tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 12 }} axisLine={false} tickLine={false} width={30} />
                <Tooltip contentStyle={{ background: "#0f1427", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 16, color: "#fff" }} />
                <Line type="monotone" dataKey="value" stroke="#7c6df2" strokeWidth={2.5} dot={{ r: 2.5, strokeWidth: 0 }} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#111528] p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_10px_30px_rgba(0,0,0,0.22)]">
          <div className="mb-3 flex items-center justify-between">
            <SectionTitle title="Throughput" />
            
          </div>
          <div className="mb-2 flex items-end gap-3">
            <div className="text-4xl font-semibold">{metrics?.throughput ? metrics.throughput.toLocaleString() : '0'}</div>
            {metrics?.throughputChange !== undefined && (
              <div className={`rounded-full px-2.5 py-1 text-xs font-semibold ${metrics.throughputChange >= 0 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>
                {metrics.throughputChange >= 0 ? '↗' : '↘'} {Math.abs(metrics.throughputChange)}%
              </div>
            )}
          </div>
          <div className="text-sm text-white/55">Average per minute</div>
          <div className="mt-3 h-[180px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={throughputData}>
                <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis dataKey="label" tick={false} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 12 }} axisLine={false} tickLine={false} width={30} />
                <Tooltip contentStyle={{ background: "#0f1427", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 16, color: "#fff" }} />
                <Bar dataKey="value" radius={[6, 6, 0, 0]} fill="#7c6df2" isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#111528] p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_10px_30px_rgba(0,0,0,0.22)]">
          <div className="mb-3 flex items-center justify-between">
            <SectionTitle title="System Health" />
            <div className="text-sm font-medium text-emerald-300">All systems operational</div>
          </div>
          <div className="space-y-2">
            {health ? health.map((item) => (
              <div key={item.name} className="flex items-center justify-between rounded-xl px-2 py-2 hover:bg-white/5 transition">
                <div className="flex items-center gap-3">
                  <span className={`h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(94,208,140,0.6)]`} />
                  <span className="text-sm text-white/72">{item.name}</span>
                </div>
                <span className="text-sm text-white/55 font-mono">{item.ms}</span>
              </div>
            )) : <div className="animate-pulse space-y-2">{[1,2,3,4,5].map(i => <div key={i} className="h-8 bg-white/5 rounded-xl" />)}</div>}
          </div>
          <button onClick={() => navigate('/health')} className="mt-3 w-full rounded-xl border border-white/10 bg-white/5 py-2.5 text-sm text-violet-200 hover:bg-white/10 transition">View all health →</button>
        </div>
      </div>

      {/* Bottom section */}
      <div className="mt-4 grid gap-4 xl:grid-cols-[1.7fr_0.8fr_0.8fr]">
        <div className="rounded-2xl border border-white/10 bg-[#111528] p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_10px_30px_rgba(0,0,0,0.22)]">
          <div className="mb-3 flex items-center justify-between">
            <SectionTitle title="Active Workers" />
            <div className="text-sm text-emerald-300">{workers?.filter(w => w.status === 'ONLINE').length ?? 0} online</div>
          </div>
          <div className="overflow-hidden rounded-2xl border border-white/10">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-white/[0.03] text-white/50">
                <tr>
                  <th className="px-4 py-3 font-medium">Worker ID</th>
                  <th className="px-4 py-3 font-medium">Pool</th>
                  <th className="px-4 py-3 font-medium">Current Job</th>
                  <th className="px-4 py-3 font-medium">CPU</th>
                  <th className="px-4 py-3 font-medium">Memory</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {workers ? workers.map((w) => (
                  <tr key={w.id} className="hover:bg-white/[0.04] transition">
                    <td className="px-4 py-3 text-white/85 font-mono text-xs">{w.id}</td>
                    <td className="px-4 py-3 text-white/60">{w.pool}</td>
                    <td className="px-4 py-3 text-violet-300 font-mono text-xs">{w.currentJobId?.substring(0,8) ?? 'Idle'}</td>
                    <td className="px-4 py-3 text-white/70">{w.cpu}%</td>
                    <td className="px-4 py-3 text-white/70">{w.memory}</td>
                    <td className="px-4 py-3"><StatusPill status={w.status} /></td>
                  </tr>
                )) : <tr><td colSpan={6} className="px-4 py-8 text-center text-white/50 animate-pulse">Loading workers...</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#111528] p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_10px_30px_rgba(0,0,0,0.22)]">
          <SectionTitle title="Quick Actions" />
          <div className="space-y-2">
            {[
              { label: "Enqueue a Job", icon: Plus, action: () => document.dispatchEvent(new Event('openEnqueue')) },
              { label: "Replay Dead Letter", icon: Repeat, action: () => navigate('/dlq') },
              { label: "View Metrics", icon: Gauge, action: () => navigate('/metrics') },
              { label: "Create Schedule", icon: CalendarDays, action: () => navigate('/schedules') },
            ].map((item) => (
              <button key={item.label} onClick={item.action} className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/80 hover:bg-white/10 transition group">
                <span className="flex items-center gap-3">
                  <item.icon className="h-4 w-4 text-white/55 group-hover:text-white transition" />
                  {item.label}
                </span>
                <ChevronRight className="h-4 w-4 text-white/35 group-hover:text-white transition" />
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#111528] p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_10px_30px_rgba(0,0,0,0.22)] flex flex-col">
          <SectionTitle title="Enqueue Job" />
          <button onClick={() => document.dispatchEvent(new Event('openEnqueue'))} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-950/30 hover:brightness-110 active:scale-95 transition">
            <Plus className="h-4 w-4" /> Enqueue Job
          </button>
          <div className="mt-3 rounded-2xl border border-white/10 bg-white/5 p-3 text-sm text-white/60">
            Add a new task, assign a queue, and watch it flow through the system in real time.
          </div>
        </div>
      </div>

      <JobDrawer 
        job={selectedJob} 
        isOpen={!!selectedJob} 
        onClose={() => setSelectedJob(null)} 
        onReplay={async (id) => { await replayDlq(id); setSelectedJob(null); }}
        onDiscard={async (id) => { await discardDlq(id); setSelectedJob(null); }}
        onRetry={retryJob ? async (id) => { await retryJob(id); setSelectedJob(null); } : undefined}
      />
    </>
  );
}

// ================= ADDITIONAL VIEWS =================

function HealthView() {
  const { health } = useAura();
  return (
    <div className="rounded-2xl border border-white/10 bg-[#111528] p-6 shadow-xl max-w-4xl mx-auto">
      <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-3">
        <ShieldCheck className="h-6 w-6 text-emerald-400" /> System Health Details
      </h2>
      <div className="space-y-3">
        {health ? health.map((item) => (
          <div key={item.name} className="flex items-center justify-between rounded-xl px-5 py-4 hover:bg-white/5 border border-white/5 transition">
            <div className="flex items-center gap-4">
              <span className={`h-3 w-3 rounded-full ${item.state === 'ok' ? 'bg-emerald-400' : 'bg-rose-400'} shadow-[0_0_12px_rgba(94,208,140,0.6)]`} />
              <div>
                <div className="text-base font-medium text-white">{item.name}</div>
                <div className="text-sm text-white/50">{item.status}</div>
              </div>
            </div>
            <span className="text-sm text-white/80 font-mono bg-white/5 px-3 py-1.5 rounded-lg">{item.ms}</span>
          </div>
        )) : <div className="animate-pulse space-y-3">{[1,2,3,4,5].map(i => <div key={i} className="h-16 bg-white/5 rounded-xl" />)}</div>}
      </div>
    </div>
  );
}

function MetricsView() {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#111528] p-6 shadow-xl">
      <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-3">
        <Gauge className="h-6 w-6 text-violet-400" /> Full Metrics Dashboard
      </h2>
      <p className="text-white/50 mb-6">Detailed metrics and historical exploration are available here.</p>
      <div className="opacity-80 pointer-events-none scale-[0.98] origin-top">
        <DashboardView />
      </div>
    </div>
  );
}

function SchedulesView() {
  const schedules = [
    { name: 'daily.database.backup', cron: '0 0 * * *', nextRun: 'in 2 hours', status: 'ACTIVE', lastRun: '22 hours ago' },
    { name: 'weekly.analytics.report', cron: '0 0 * * 0', nextRun: 'in 4 days', status: 'ACTIVE', lastRun: '3 days ago' },
    { name: 'hourly.cache.sync', cron: '0 * * * *', nextRun: 'in 15 mins', status: 'PAUSED', lastRun: 'Never' },
  ];
  return (
    <div className="rounded-2xl border border-white/10 bg-[#111528] p-6 shadow-xl max-w-4xl mx-auto">
      <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-3">
        <CalendarDays className="h-6 w-6 text-amber-400" /> Scheduled Jobs
      </h2>
      <div className="space-y-3">
        {schedules.map(s => (
          <div key={s.name} className="flex flex-col sm:flex-row sm:items-center justify-between rounded-xl px-5 py-4 hover:bg-white/5 border border-white/5 transition gap-4">
             <div className="flex items-center gap-4">
               <div className="grid h-10 w-10 place-items-center rounded-xl bg-amber-500/15 text-amber-400">
                 <CalendarDays className="h-5 w-5" />
               </div>
               <div>
                  <div className="text-base font-medium text-white">{s.name}</div>
                  <div className="text-sm text-white/50 font-mono mt-1">{s.cron}</div>
               </div>
             </div>
             <div className="flex items-center gap-6 text-right">
                <div className="hidden sm:block">
                   <div className="text-xs text-white/40">Last Run</div>
                   <div className="text-sm text-white/70">{s.lastRun}</div>
                </div>
                <div>
                   <div className="text-xs text-white/40">Next Run</div>
                   <div className="text-sm text-white/90">{s.nextRun}</div>
                </div>
                <div className={`text-[10px] font-bold uppercase w-16 text-center rounded-full px-2 py-1 ring-1 ${s.status === 'ACTIVE' ? 'text-emerald-400 ring-emerald-400/30 bg-emerald-400/10' : 'text-amber-400 ring-amber-400/30 bg-amber-400/10'}`}>
                  {s.status}
                </div>
             </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function JobsView({ search }: { search: string }) {
  const { replayDlq, discardDlq, retryJob } = useAura();
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);

  const jobsQuery = useInfiniteQuery({
    queryKey: ['jobs-list', search],
    initialPageParam: null as { cursorCreatedAt: string; cursorId: string } | null,
    queryFn: ({ pageParam }) => jobsService.list({
      search: search || undefined,
      limit: 100,
      cursorCreatedAt: pageParam?.cursorCreatedAt,
      cursorId: pageParam?.cursorId,
    }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const jobs = jobsQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const total = jobsQuery.data?.pages[0]?.total ?? 0;

  return (
    <div className="rounded-2xl border border-white/10 bg-[#111528] p-6 shadow-xl">
      <h2 className="text-xl font-semibold text-white mb-6">
        All Jobs
        <span className="text-sm text-white/50 ml-2">{total.toLocaleString()} total</span>
        {search && <span className="text-sm text-white/50 ml-2">Filtering by "{search}"</span>}
      </h2>
      <div className="space-y-2">
        {jobs.length ? jobs.map(job => (
          <div key={job.id} onClick={() => setSelectedJob(job)} className="flex items-center gap-3 rounded-xl px-4 py-3 hover:bg-white/5 cursor-pointer transition border border-transparent hover:border-white/10">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/5 text-white/50">
              <Database className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-white">{job.name}</div>
              <div className="text-xs text-white/35 font-mono mt-0.5">{job.id}</div>
            </div>
            <StatusPill status={job.status} />
          </div>
        )) : <div className="text-center py-10 text-white/40">{jobsQuery.isLoading ? 'Loading jobs...' : 'No jobs found'}</div>}
      </div>
      {jobsQuery.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <button
            onClick={() => jobsQuery.fetchNextPage()}
            disabled={jobsQuery.isFetchingNextPage}
            className="h-10 rounded-xl border border-white/10 bg-white/5 px-4 text-sm text-white/80 hover:bg-white/10 disabled:opacity-60"
          >
            {jobsQuery.isFetchingNextPage ? 'Loading more...' : 'Load more'}
          </button>
        </div>
      )}
      <JobDrawer 
        job={selectedJob} 
        isOpen={!!selectedJob} 
        onClose={() => setSelectedJob(null)} 
        onReplay={async (id) => { await replayDlq(id); setSelectedJob(null); }}
        onDiscard={async (id) => { await discardDlq(id); setSelectedJob(null); }}
        onRetry={retryJob ? async (id) => { await retryJob(id); setSelectedJob(null); } : undefined}
      />
    </div>
  );
}

function DlqView() {
  const { replayDlq, discardDlq, retryJob } = useAura();
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const dlqQuery = useInfiniteQuery({
    queryKey: ['dlqJobs'],
    initialPageParam: null as { cursorCreatedAt: string; cursorId: string } | null,
    queryFn: ({ pageParam }) => jobsService.getDlq({
      limit: 100,
      cursorCreatedAt: pageParam?.cursorCreatedAt,
      cursorId: pageParam?.cursorId,
    }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const dlqJobs = dlqQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const total = dlqQuery.data?.pages[0]?.total ?? 0;

  return (
    <div className="rounded-2xl border border-rose-500/20 bg-[#111528] p-6 shadow-xl">
      <div className="flex items-center gap-3 mb-6">
        <div className="h-10 w-10 bg-rose-500/15 text-rose-400 rounded-xl flex items-center justify-center">
          <TriangleAlert size={20} />
        </div>
        <h2 className="text-xl font-semibold text-white">Dead Letter Queue</h2>
        <span className="text-sm text-white/50 ml-2">{total.toLocaleString()} total</span>
      </div>
      
      {dlqJobs?.length === 0 ? (
        <div className="text-center py-20 text-white/50 flex flex-col items-center">
          <div className="h-16 w-16 bg-white/5 rounded-full flex items-center justify-center mb-4">
            <Database size={24} className="text-white/30" />
          </div>
          <p className="text-lg">DLQ is empty</p>
          <p className="text-sm mt-1">All systems are operating normally.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {dlqJobs.length ? dlqJobs.map(job => (
            <div key={job.id} onClick={() => setSelectedJob(job)} className="flex items-center gap-3 rounded-xl px-4 py-3 hover:bg-rose-500/5 cursor-pointer transition border border-transparent hover:border-rose-500/10">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-white">{job.name}</div>
                <div className="text-xs text-white/35 font-mono mt-0.5">{job.id}</div>
              </div>
              <StatusPill status={job.status} />
            </div>
          )) : <div className="text-center py-10 text-white/40">{dlqQuery.isLoading ? 'Loading dead letters...' : 'No dead letters found'}</div>}
        </div>
      )}
      {dlqQuery.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <button
            onClick={() => dlqQuery.fetchNextPage()}
            disabled={dlqQuery.isFetchingNextPage}
            className="h-10 rounded-xl border border-white/10 bg-white/5 px-4 text-sm text-white/80 hover:bg-white/10 disabled:opacity-60"
          >
            {dlqQuery.isFetchingNextPage ? 'Loading more...' : 'Load more'}
          </button>
        </div>
      )}
      <JobDrawer 
        job={selectedJob} 
        isOpen={!!selectedJob} 
        onClose={() => setSelectedJob(null)} 
        onReplay={async (id) => { await replayDlq(id); setSelectedJob(null); }}
        onDiscard={async (id) => { await discardDlq(id); setSelectedJob(null); }}
        onRetry={retryJob ? async (id) => { await retryJob(id); setSelectedJob(null); } : undefined}
      />
    </div>
  );
}

function WorkersView() {
  const { workers } = useAura();

  return (
    <div className="rounded-2xl border border-white/10 bg-[#111528] overflow-hidden shadow-xl">
      <div className="p-6 border-b border-white/10 flex justify-between items-center bg-[#111528]">
        <h3 className="text-xl font-semibold text-white flex items-center gap-3">
          <Server className="text-violet-400" size={24} />
          Worker Fleet
          {workers && <span className="ml-2 text-xs text-emerald-300 bg-emerald-500/15 px-2.5 py-1 rounded-full uppercase tracking-tighter ring-1 ring-emerald-500/20">{workers.filter(w => w.status === 'ONLINE').length} Online</span>}
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-white/5 text-white/50">
            <tr>
              <th className="px-6 py-4 font-medium">Worker ID</th>
              <th className="px-6 py-4 font-medium">Current Job</th>
              <th className="px-6 py-4 font-medium">Pool</th>
              <th className="px-6 py-4 w-48 font-medium">CPU / MEM</th>
              <th className="px-6 py-4 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {workers ? workers.map(w => (
              <tr key={w.id} className="hover:bg-white/[0.04] transition">
                <td className="px-6 py-4 font-mono text-xs text-white/80">{w.id}</td>
                <td className="px-6 py-4 text-xs text-violet-300 hover:underline cursor-pointer font-mono">{w.currentJobId ? `${w.currentJobId.substring(0,8)}` : 'Idle'}</td>
                <td className="px-6 py-4 text-xs font-mono text-white/60">{w.pool}</td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden"><div className="h-full bg-violet-500 transition-all duration-1000" style={{ width: `${w.cpu}%` }}/></div>
                    <span className="text-[10px] text-white/50 w-8">{w.memory}</span>
                  </div>
                </td>
                <td className="px-6 py-4"><StatusPill status={w.status} /></td>
              </tr>
            )) : <tr><td colSpan={5} className="px-6 py-8 text-center text-white/40 animate-pulse text-sm">Loading workers...</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}



function StatusPill({ status }: { status?: string }) {
  const tones: Record<string, string> = {
    PROCESSING: "bg-sky-500/15 text-sky-300 ring-sky-500/20",
    COMPLETED: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/20",
    FAILED: "bg-rose-500/15 text-rose-300 ring-rose-500/20",
    DEAD_LETTER: "bg-rose-500/15 text-rose-300 ring-rose-500/20",
    PENDING: "bg-violet-500/15 text-violet-300 ring-violet-500/20",
    DELAYED: "bg-amber-500/15 text-amber-300 ring-amber-500/20",
    ONLINE: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/20",
    OFFLINE: "bg-white/10 text-white/50 ring-white/10",
  };
  const key = status ?? '';
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ring-1 ${tones[key] ?? tones.PENDING}`}>{status ?? '—'}</span>;
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}

function EnqueueJobModalWrapper({ isEnqueueOpen, setIsEnqueueOpen }: any) {
  const { enqueueJob } = useAura();
  
  React.useEffect(() => {
    const handleOpen = () => setIsEnqueueOpen(true);
    document.addEventListener('openEnqueue', handleOpen);
    return () => document.removeEventListener('openEnqueue', handleOpen);
  }, [setIsEnqueueOpen]);

  return <EnqueueJobModal isOpen={isEnqueueOpen} onClose={() => setIsEnqueueOpen(false)} onEnqueue={enqueueJob} />;
}

function StatCard({ title, value, delta, deltaTone, icon: Icon, sparkColor, sparkData }: any) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#111528] p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_10px_30px_rgba(0,0,0,0.22)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm text-white/60">{title}</div>
          <div className="mt-2 text-4xl font-semibold tracking-tight text-white">{value.toLocaleString()}</div>
        </div>
        <div className="grid h-12 w-12 place-items-center rounded-full bg-white/5 text-white/80 ring-1 ring-white/10">
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <div className="mt-4 flex items-end justify-between gap-3">
        {delta ? <div className={`text-sm font-medium ${deltaTone}`}>{delta} <span className="text-white/45 font-normal">vs last hour</span></div> : <div />}
        <div className="h-12 w-24">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparkData.length ? sparkData : [{value:0},{value:0}]}>
              <defs>
                <linearGradient id={`g-${title.replace(/\s+/g, '')}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={sparkColor} stopOpacity={0.45} />
                  <stop offset="95%" stopColor={sparkColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="value" stroke={sparkColor} fill={`url(#g-${title.replace(/\s+/g, '')})`} strokeWidth={2} dot={false} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ title, action, onAction }: any) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 w-full">
      <h3 className="text-base font-semibold text-white">{title}</h3>
      {action ? <button onClick={onAction} className="text-sm text-white/55 hover:text-white transition">{action}</button> : null}
    </div>
  );
}
