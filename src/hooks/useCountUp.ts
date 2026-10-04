import { useEffect, useRef, useState } from "react";

/** Animates a number from its previous value to `target` (ease-out cubic). */
export function useCountUp(target: number | null, durationMs = 900): number | null {
  const [value, setValue] = useState<number | null>(target);
  const from = useRef(0);

  useEffect(() => {
    if (target === null) {
      setValue(null);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let raf = 0;
    function tick(now: number) {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = origin + (target! - origin) * eased;
      setValue(v);
      if (t < 1) raf = requestAnimationFrame(tick);
      else from.current = target!;
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return value;
}
