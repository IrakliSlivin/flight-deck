// Stands in for @tauri-apps/api/event in demo mode: an in-page event bus.
export type UnlistenFn = () => void;

interface Event<T> {
  event: string;
  id: number;
  payload: T;
}

const listeners = new Map<string, Set<(e: Event<unknown>) => void>>();
let nextId = 0;

export async function listen<T>(event: string, handler: (e: Event<T>) => void): Promise<UnlistenFn> {
  const set = listeners.get(event) ?? new Set();
  listeners.set(event, set);
  const fn = handler as (e: Event<unknown>) => void;
  set.add(fn);
  return () => set.delete(fn);
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  listeners.get(event)?.forEach((fn) => fn({ event, id: nextId++, payload }));
}
