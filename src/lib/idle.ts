import { useSyncExternalStore } from "react";

// Marks <html data-idle> while the window is unfocused or hidden, so index.css can
// pause the endless CSS animations. WebKitGTK keeps animating (and Skia keeps
// repainting) a window that is merely covered, which kept the web process near
// 100% CPU all day. Components that tick on timers can read it with useIdle().
let idle = false;
const listeners = new Set<() => void>();

function sync() {
  const next = document.hidden || !document.hasFocus();
  document.documentElement.toggleAttribute("data-idle", next);
  if (next === idle) return;
  idle = next;
  listeners.forEach((fn) => fn());
}

window.addEventListener("focus", sync);
// Focus moving into an iframe (Ops Atlas) blurs the window but the document keeps focus.
window.addEventListener("blur", () => setTimeout(sync, 0));
document.addEventListener("visibilitychange", sync);
sync();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** True while the window is unfocused or hidden. */
export function useIdle(): boolean {
  return useSyncExternalStore(subscribe, () => idle);
}
