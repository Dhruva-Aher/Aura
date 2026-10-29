const STORAGE_KEY = 'aura.dashboard.v1';
/** Keep last dashboard paint across tab closes so return visits are not blank. */
const MAX_AGE_MS = 30 * 60 * 1000;

export type DashboardCache = {
  metrics?: unknown;
  metricsAt?: number;
  pulse?: unknown;
  pulseAt?: number;
  recentJobs?: unknown;
  recentJobsAt?: number;
  workers?: unknown;
  workersAt?: number;
  health?: unknown;
  healthAt?: number;
};

function fresh<T>(value: T | undefined, at: number | undefined, now: number): T | undefined {
  if (value == null || at == null) return undefined;
  if (now - at > MAX_AGE_MS) return undefined;
  return value;
}

function readRaw(): DashboardCache {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as DashboardCache;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function read(): DashboardCache {
  const raw = readRaw();
  const now = Date.now();
  return {
    metrics: fresh(raw.metrics, raw.metricsAt, now),
    metricsAt: raw.metricsAt,
    pulse: fresh(raw.pulse, raw.pulseAt, now),
    pulseAt: raw.pulseAt,
    recentJobs: fresh(raw.recentJobs, raw.recentJobsAt, now),
    recentJobsAt: raw.recentJobsAt,
    workers: fresh(raw.workers, raw.workersAt, now),
    workersAt: raw.workersAt,
    health: fresh(raw.health, raw.healthAt, now),
    healthAt: raw.healthAt,
  };
}

export function readDashboardCache(): DashboardCache {
  return read();
}

let pending: DashboardCache = {};
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  if (!Object.keys(pending).length) return;
  const partial = pending;
  pending = {};
  try {
    const next = { ...readRaw(), ...partial };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode or a full quota should not block the live dashboard.
  }
}

export function writeDashboardCache(partial: DashboardCache) {
  pending = { ...pending, ...partial };
  if (timer != null) return;
  timer = setTimeout(flush, 1500);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush);
}
