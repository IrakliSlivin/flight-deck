import { useEffect, useRef, useState } from "react";
import { Card, SectionHeader, GhostButton } from "./Card";
import { CloseIcon, ExpandIcon } from "./Icons";

// Bundled copy of the "Claude Ops Atlas" artifact (public/atlas/index.html).
const ATLAS_SRC = "/atlas/index.html";

export function AtlasCard({ delay = 0 }: { delay?: number }) {
  const [full, setFull] = useState(false);
  // Full screen starts below the TopBar so its tabs stay clickable.
  const [top, setTop] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!full) return;
    const measure = () =>
      setTop(cardRef.current?.closest("main")?.getBoundingClientRect().top ?? 0);
    measure();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    window.addEventListener("resize", measure);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("keydown", onKey);
    };
  }, [full]);

  // Keys typed while the graph has focus go to the iframe, so forward Escape from it.
  function onFullLoad(e: React.SyntheticEvent<HTMLIFrameElement>) {
    e.currentTarget.contentWindow?.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") setFull(false);
    });
  }

  return (
    <>
      <Card tone="glass" delay={delay} className="flex flex-col !p-0" style={{ scrollMarginTop: 16 }}>
        <div id="ops-atlas" ref={cardRef} className="px-5 pt-4">
          <SectionHeader
            title={
              <>
                Ops Atlas <span className="text-slate-500">·</span>{" "}
                <span className="text-slate-400">evex_billing</span>
              </>
            }
            right={
              <GhostButton onClick={() => setFull(true)} title="Open full screen">
                <span className="flex items-center gap-1.5">
                  <ExpandIcon className="h-3 w-3" /> Expand
                </span>
              </GhostButton>
            }
          />
        </div>
        <iframe
          src={ATLAS_SRC}
          title="Claude Ops Atlas"
          className="h-[560px] w-full rounded-b-2xl border-t border-white/[0.06]"
        />
      </Card>

      {full && (
        <div
          className="fixed inset-x-0 bottom-0 z-50 flex flex-col bg-[#070b14]/95"
          style={{ top, animation: "fade-in .2s ease-out" }}
        >
          <div className="flex items-center justify-between px-5 py-3">
            <span className="label text-slate-400">Ops Atlas · evex_billing</span>
            <button
              onClick={() => setFull(false)}
              className="rounded-full border border-white/10 p-1.5 text-slate-400 hover:text-white"
              aria-label="Close"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>
          <iframe
            src={ATLAS_SRC}
            title="Claude Ops Atlas (full screen)"
            className="w-full flex-1"
            onLoad={onFullLoad}
          />
        </div>
      )}
    </>
  );
}
