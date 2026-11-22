import { createContext, createElement, useContext, useEffect, useMemo, useState } from 'react';

const eventTypes = [
  'notification',
  'incident-changed',
  'dashboard-changed',
  'workload-changed',
  'inbox-changed',
];
const empty = { connected: false, subscribe: () => () => {} };
const LiveContext = createContext(empty);

/** Shares one connection across the signed-in app and refreshes after reconnection. */
export function LiveProvider({ children }) {
  const [connected, setConnected] = useState(false);
  const [latest, setLatest] = useState(null);
  const subscribe = useMemo(() => {
    const listeners = new Set();
    const add = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    return {
      add,
      emit: (event) => {
        for (const listener of listeners) listener(event);
      },
    };
  }, []);

  useEffect(() => {
    if (!window.EventSource) return;
    const stream = new EventSource('/api/events');
    const open = () => {
      setConnected(true);
      subscribe.emit({ type: 'connected' });
    };
    function accept(event) {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!payload || !eventTypes.includes(payload.type)) return;
      if (payload.type === 'notification') setLatest(payload);
      subscribe.emit(payload);
    }
    stream.addEventListener('open', open);
    stream.addEventListener('error', () => setConnected(false));
    for (const type of eventTypes) stream.addEventListener(type, accept);
    return () => stream.close();
  }, [subscribe]);

  useEffect(() => {
    if (!latest) return;
    const timeout = setTimeout(() => setLatest(null), 5500);
    return () => clearTimeout(timeout);
  }, [latest]);
  const value = useMemo(
    () => ({ connected, subscribe: subscribe.add, latest, dismiss: () => setLatest(null) }),
    [connected, subscribe, latest],
  );
  return createElement(LiveContext.Provider, { value }, children);
}

/** Read the current connection and subscribe to its committed event envelopes. */
export function useLiveEvents() {
  return useContext(LiveContext);
}
