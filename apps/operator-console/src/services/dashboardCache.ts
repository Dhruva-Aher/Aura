const STORAGE_KEY = 'aura.dashboard.v1';

export type DashboardCache = {
  metrics?: unknown;
  metricsAt?: number;
  pulse?: unknown;
  pulseAt?: number;
  recentJobs?: unknown;
  recentJobsAt?: number;
  workers?: unknown;
  workersAt?: number;
};

function read(): DashboardCache {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as DashboardCache;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function readDashboardCache(): DashboardCache {
  return read();
}

export function writeDashboardCache(partial: DashboardCache) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...read(), ...partial }));
  } catch {
    // Private mode or a full quota should not block the live dashboard.
  }
}
