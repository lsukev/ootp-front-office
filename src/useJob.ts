import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from './api';

/**
 * Watches a generation that runs on the server rather than in the request.
 *
 * Storylines and the briefing take the better part of a minute. They used to
 * hold the request open, so starting one meant staying on the page until it
 * finished and losing the wait if you went anywhere. Now the server keeps the
 * job and this asks how it is doing, which means you can start one and go and
 * do something else.
 *
 * Polling continues across page changes because the hook lives with the page —
 * but the work does not, so leaving and coming back picks up whatever state
 * the job reached in the meantime.
 */

export interface JobStatus {
  state: 'idle' | 'running' | 'done' | 'error';
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

interface WithJob {
  job?: JobStatus;
}

export function useJob<T extends WithJob>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const running = data?.job?.state === 'running';

  const load = useCallback(async () => {
    try {
      const next = await apiGet<T>(path);
      if (!alive.current) return;
      setData(next);
      // A job that failed reports why, and the message is more useful than the
      // generic one a failed request would give
      if (next.job?.state === 'error' && next.job.error) setError(next.job.error);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }, [path]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  // Ask again while it is working. Two seconds is often enough to feel live
  // without making a nuisance of itself on a job that runs for a minute.
  useEffect(() => {
    if (!running) return;
    timer.current = setTimeout(() => void load(), 2000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [running, data, load]);

  const start = useCallback(async () => {
    setError(null);
    setStarting(true);
    try {
      await apiPost(path, {});
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }, [path, load]);

  return { data, error, running: running || starting, start, reload: load, setError };
}
