import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  Activity, Layers, AlertCircle, Calendar, Server, Cpu, Heart,
  BarChart3, AlertTriangle, List, Shield, Inbox, Settings, Key,
  ChevronRight, Zap
} from 'lucide-react';

export const Sidebar: React.FC<{ onEnqueue: () => void }> = ({ onEnqueue }) => {
  return (
    <aside className="w-[232px] shrink-0 bg-background-main border-r border-border flex flex-col h-[calc(100vh-68px)]">
      <nav className="flex-1 px-3 py-4 space-y-5 overflow-y-auto custom-scrollbar">
        <div>
          <SidebarItem icon={<Activity size={16} />} label="Overview" to="/" />
        </div>
        <div>
          <NavLabel>Jobs</NavLabel>
          <SidebarItem icon={<Layers size={16} />} label="Jobs" to="/jobs" />
          <SidebarItem icon={<Zap size={16} />} label="Enqueue Job" to="#" onClick={onEnqueue} />
          <SidebarItem icon={<AlertCircle size={16} />} label="Dead Letter Queue" to="/dlq" />
          <SidebarItem icon={<Calendar size={16} />} label="Metrics" to="/metrics-view" />
        </div>
        <div>
          <NavLabel>Workers</NavLabel>
          <SidebarItem icon={<Server size={16} />} label="Workers" to="/workers" />
          <SidebarItem icon={<Cpu size={16} />} label="System Health" to="/system-health" />
          <SidebarItem icon={<Heart size={16} />} label="Overview" to="/" />
        </div>
        <div>
          <NavLabel>Monitoring</NavLabel>
          <SidebarItem icon={<BarChart3 size={16} />} label="Metrics" to="/metrics-view" />
          <SidebarItem icon={<AlertTriangle size={16} />} label="Dead Letter Queue" to="/dlq" />
          <SidebarItem icon={<List size={16} />} label="Jobs" to="/jobs" />
          <SidebarItem icon={<Shield size={16} />} label="System Health" to="/system-health" />
        </div>
        <div>
          <NavLabel>Settings</NavLabel>
          <SidebarItem icon={<Inbox size={16} />} label="Queues" to="/jobs" />
          <SidebarItem icon={<Settings size={16} />} label="Settings" to="/" />
          <SidebarItem icon={<Key size={16} />} label="API Keys" to="/" />
        </div>
      </nav>

      {/* User profile */}
      <div className="p-3 border-t border-border mt-auto">
        <NavLink to="/" className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/5 transition-colors group">
          <div className="h-8 w-8 rounded-full bg-accent-indigo/20 text-accent-indigo flex items-center justify-center font-bold text-xs shrink-0 group-hover:bg-accent-indigo group-hover:text-white transition-colors">
            AD
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">Admin</p>
            <p className="text-xs text-text-muted truncate">admin@aura.dev</p>
          </div>
          <ChevronRight size={14} className="text-text-muted group-hover:text-text-primary" />
        </NavLink>
      </div>
    </aside>
  );
};

function NavLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] uppercase tracking-[0.18em] font-semibold text-text-muted px-3 mb-2">{children}</p>;
}

function SidebarItem({ icon, label, to, onClick }: { icon: React.ReactNode; label: string; to: string; onClick?: () => void }) {
  if (to === '#') {
    return (
      <div onClick={onClick} className="flex items-center gap-3 px-3 py-2 rounded-lg text-text-muted hover:bg-white/5 hover:text-text-primary cursor-pointer transition-all text-[12px] font-medium mb-1">
        {icon}<span>{label}</span>
      </div>
    );
  }
  return (
    <NavLink to={to} end={to === '/'}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-all text-[12px] font-medium mb-1 ${
          isActive 
            ? 'bg-accent-indigo/90 text-white shadow-md shadow-indigo-500/20' 
            : 'text-text-muted hover:bg-white/5 hover:text-text-primary'
        }`
      }
    >
      {icon}<span>{label}</span>
    </NavLink>
  );
}
