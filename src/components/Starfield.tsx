import { useEffect, useRef } from "react";

interface Star {
  x: number;
  y: number;
  z: number; // depth 0..1 — drives size, brightness, drift speed
  phase: number;
}

interface Mote {
  angle: number;
  radius: number;
  speed: number;
  size: number;
}

const STAR_DENSITY = 1 / 5200; // stars per px²
const MOTES = 420;
const LINK_DIST = 110;
// 60fps of full-window software canvas kept the web process at ~100% CPU; the
// drift is slow enough that 30fps looks the same.
const FRAME_MS = 1000 / 30;

/**
 * Full-window animated backdrop: drifting, twinkling stars that link up near
 * the cursor, plus a slow-rotating galaxy swirl on the right, level with the action row.
 */
export function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let w = 0;
    let h = 0;
    let stars: Star[] = [];
    let core: CanvasGradient | null = null;
    const motes: Mote[] = Array.from({ length: MOTES }, () => {
      // Denser near the core, with two loose spiral arms.
      const arm = Math.random() < 0.5 ? 0 : Math.PI;
      const radius = Math.pow(Math.random(), 1.6) * 1;
      return {
        angle: arm + radius * 5.5 + (Math.random() - 0.5) * 0.9,
        radius,
        speed: 0.00005 + (1 - radius) * 0.00012,
        size: Math.random() * 1.3 + 0.3,
      };
    });
    const mouse = { x: -9999, y: -9999 };

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(w * h * STAR_DENSITY);
      core = null;
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        z: Math.random(),
        phase: Math.random() * Math.PI * 2,
      }));
    }

    function drawGalaxy(t: number) {
      // Fixed to the window: where the gap between the last two action buttons sits on Overview
      // at the top of the page, with the mail brief filled in.
      const cx = w * 0.755;
      const cy = h * 0.66;
      const scale = Math.min(w, h) * 0.55;

      if (!core) {
        core = ctx.createRadialGradient(cx, cy, 0, cx, cy, scale * 0.5);
        core.addColorStop(0, "rgba(148, 163, 214, 0.14)");
        core.addColorStop(0.4, "rgba(99, 102, 241, 0.06)");
        core.addColorStop(1, "rgba(0, 0, 0, 0)");
      }
      ctx.fillStyle = core;
      // Only the gradient's radius needs painting, not the whole window.
      const r = scale * 0.5;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

      ctx.fillStyle = "rgb(203, 213, 245)";
      for (const m of motes) {
        const a = m.angle + t * m.speed;
        // Tilted ellipse so the disc reads as seen at an angle.
        const x = cx + Math.cos(a) * m.radius * scale;
        const y = cy + Math.sin(a) * m.radius * scale * 0.42;
        ctx.globalAlpha = 0.22 + (1 - m.radius) * 0.5;
        ctx.fillRect(x, y, m.size, m.size);
      }
      ctx.globalAlpha = 1;
    }

    let raf = 0;
    let last = performance.now();
    let running = false;

    function frame(now: number) {
      raf = requestAnimationFrame(frame);
      if (now - last < FRAME_MS - 2) return;
      draw(now);
    }

    function draw(now: number) {
      const dt = Math.min(48, now - last);
      last = now;
      ctx.clearRect(0, 0, w, h);

      drawGalaxy(now);

      for (const s of stars) {
        if (!reduce) {
          s.x -= dt * 0.004 * (0.3 + s.z);
          s.y += dt * 0.0015 * (0.3 + s.z);
          if (s.x < -2) s.x = w + 2;
          if (s.y > h + 2) s.y = -2;
        }
        const twinkle = reduce ? 1 : 0.6 + 0.4 * Math.sin(now * 0.0015 * (0.5 + s.z) + s.phase);
        const r = 0.45 + s.z * 1.25;
        ctx.globalAlpha = Math.min(1, (0.4 + s.z * 0.6) * twinkle);
        ctx.fillStyle = s.z > 0.93 ? "#fde68a" : "#e2e8f0";
        if (r < 1) {
          // Sub-pixel stars look the same as squares and skip path building.
          ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2);
        } else {
          ctx.beginPath();
          ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      // Constellation lines between stars near the cursor.
      const near = stars.filter(
        (s) => Math.abs(s.x - mouse.x) < 180 && Math.abs(s.y - mouse.y) < 180,
      );
      ctx.lineWidth = 0.7;
      for (let i = 0; i < near.length; i++) {
        for (let j = i + 1; j < near.length; j++) {
          const a = near[i];
          const b = near[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < LINK_DIST) {
            ctx.strokeStyle = `rgba(251, 191, 36, ${0.04 + 0.36 * (1 - d / LINK_DIST)})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
    }

    function start() {
      if (running) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    function stop() {
      running = false;
      cancelAnimationFrame(raf);
    }

    function onMove(e: MouseEvent) {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    }
    function onLeave() {
      mouse.x = mouse.y = -9999;
    }
    // Only animate while the window has focus: WebKitGTK keeps rAF running for
    // a window that is merely covered or on another workspace, which is most of
    // the day. Unfocused, the last frame stays up as a still backdrop.
    function sync() {
      if (!document.hidden && document.hasFocus()) start();
      else stop();
    }
    // Focus moving into an iframe (Ops Atlas) blurs the window but the document
    // still has focus; check after the focus change settles.
    function onBlur() {
      setTimeout(sync, 0);
    }
    function onResize() {
      resize();
      draw(performance.now());
    }

    resize();
    draw(performance.now());
    sync();
    window.addEventListener("resize", onResize);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", onBlur);
    window.addEventListener("mousemove", onMove);
    document.addEventListener("mouseleave", onLeave);
    document.addEventListener("visibilitychange", sync);
    return () => {
      stop();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-0"
    />
  );
}
