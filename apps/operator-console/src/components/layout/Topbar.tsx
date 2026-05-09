import React, { useEffect, useRef, useState } from 'react';
import { Search, Bell, Plus, Zap, AlignJustify } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAura } from '../../AuraContext';

export const Topbar: React.FC<{ onEnqueue: () => void; onToggleSidebar: () => void }> = ({ onEnqueue, onToggleSidebar }) => {
  const { metrics } = useAura();
  const [search, setSearch] = useState('');
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); inputRef.current?.focus(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (search.trim()) navigate(`/jobs?search=${encodeURIComponent(search.trim())}`);
  };

  return (
    <header className="h-[68px] bg-background-main/95 border-b border-border flex items-center px-5 shrink-0 z-20 backdrop-blur-sm">
      {/* Logo */}
      <div className="flex items-center gap-2.5 w-[236px] shrink-0 -ml-5 pl-5">
        <div className="h-8 w-8 bg-accent-indigo rounded-lg flex items-center justify-center shadow-[0_0_12px_rgba(99,102,241,0.45)]">
          <Zap size={15} className="text-white fill-white" />
        </div>
        <span className="text-white font-semibold tracking-[0.08em] text-[12px] uppercase">Aura Console</span>
        <button onClick={onToggleSidebar} className="ml-1 p-1.5 text-text-muted hover:text-text-primary hover:bg-white/5 rounded-md transition-colors">
          <AlignJustify size={15} />
        </button>
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="relative flex-1 max-w-[560px] ml-5">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={14} />
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search jobs, workers, queues..."
          className="w-full bg-white/[0.03] border border-white/10 rounded-lg py-2.5 pl-9 pr-14 text-[13px] text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-indigo/60 focus:bg-white/10 transition-all"
        />
        <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[9px] text-text-muted bg-white/5 border border-white/10 px-1.5 py-0.5 rounded font-mono flex items-center gap-0.5">
          ⌘&nbsp;K
        </kbd>
      </form>

      <div className="flex items-center gap-2.5 ml-auto">
        <button onClick={() => navigate('/dlq')} className="relative p-2 text-text-muted hover:text-text-primary hover:bg-white/5 rounded-lg transition-colors">
          <Bell size={17} />
          {(metrics?.failed?.value ?? 0) > 0 && (
            <span className="absolute top-1 right-1 h-4 w-4 bg-accent-red text-[9px] text-white flex items-center justify-center rounded-full font-bold border-2 border-background-main">
              {Math.min(metrics!.failed.value, 9)}{metrics!.failed.value > 9 ? '+' : ''}
            </span>
          )}
        </button>
        <button
          onClick={onEnqueue}
          className="flex items-center gap-1.5 bg-accent-indigo hover:bg-indigo-500 text-white px-3.5 py-2 rounded-lg text-[13px] font-semibold transition-all active:scale-95 shadow-lg shadow-indigo-500/20"
        >
          <Plus size={16} /> Enqueue Job
        </button>
      </div>
    </header>
  );
};
