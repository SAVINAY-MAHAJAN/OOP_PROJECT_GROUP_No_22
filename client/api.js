import { useCallback, useEffect, useState } from 'react';
import { useLiveEvents } from './live.js';

export class ApiError extends Error {
  constructor(status, body) {
    super(body.message || 'The request could not be completed.');
    this.status = status;
    this.code = body.code;
    this.candidates = body.candidates;
  }
}
export async function api(path, { method = 'GET', body, signal } = {}) {
  const options = { method, signal, credentials: 'same-origin' };
  if (method !== 'GET') {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body || {});
  }
  const res = await fetch('/api' + path, options);
  const result = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !['/auth/me', '/auth/login'].includes(path))
      window.dispatchEvent(new Event('nexora-session-ended'));
    throw new ApiError(res.status, result);
  }
  return result;
}
export function useJson(path, { active = true, poll = 0, events } = {}) {
  const [state, setState] = useState({ path: null, value: null, error: null });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const { connected, subscribe } = useLiveEvents();
  const delay = events && connected && poll ? 60000 : poll;
  useEffect(() => {
    if (!path || !active) return;
    const controller = new AbortController();
    let reading = false,
      queued = false,
      scheduled;
    async function read() {
      if (controller.signal.aborted) return;
      if (reading) {
        queued = true;
        return;
      }
      reading = true;
      try {
        const value = await api(path, { signal: controller.signal });
        if (!controller.signal.aborted) setState({ path, value, error: null });
      } catch (error) {
        if (!controller.signal.aborted)
          setState((old) => ({
            path,
            value: old.path === path && ![401, 403, 404].includes(error.status) ? old.value : null,
            error,
          }));
      } finally {
        reading = false;
        if (queued) {
          queued = false;
          void read();
        }
      }
    }
    void read();
    const timer = delay ? setInterval(read, delay) : null;
    const unsubscribe = events
      ? subscribe((event) => {
          const matches = typeof events === 'function' ? events(event) : events.includes(event.type);
          if (!matches && event.type !== 'connected') return;
          clearTimeout(scheduled);
          scheduled = setTimeout(read, 50);
        })
      : null;
    return () => {
      controller.abort();
      clearInterval(timer);
      clearTimeout(scheduled);
      unsubscribe?.();
    };
  }, [path, active, delay, revision, subscribe, events]);
  return {
    data: state.path === path ? state.value : null,
    error: state.path === path ? state.error : null,
    refresh,
  };
}
export const patch = (path, body) => api(path, { method: 'PATCH', body });
export const post = (path, body) => api(path, { method: 'POST', body });
export function queryString(params) {
  const values = Object.entries(params).filter(
    ([, value]) => value !== undefined && value !== null && value !== '',
  );
  return values.length ? '?' + new URLSearchParams(values).toString() : '';
}
export const encoded = encodeURIComponent;
