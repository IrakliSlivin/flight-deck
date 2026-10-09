import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TopBar } from "./components/TopBar";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { Starfield } from "./components/Starfield";
import { TABS, TabId, type TabContext } from "./tabs";
import { Review } from "./tabs/Review";
import type { PullRequest } from "./lib/prs";

function App() {
  const [active, setActive] = useState<TabId>("today");
  // The review page replaces the active tab until you go back or pick a tab.
  const [reviewPr, setReviewPr] = useState<PullRequest | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const unlisten = listen("open-palette", () => setPaletteOpen(true));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "q") {
        e.preventDefault();
        invoke("quit_app");
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  const navigate = useCallback((id: TabId) => {
    setReviewPr(null);
    setActive(id);
  }, []);

  const ctx: TabContext = { navigate, openSettings, openPalette, openReview: setReviewPr };
  const activeTab = TABS.find((tab) => tab.id === active) ?? TABS[0];

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden text-slate-100">
      <Starfield />
      <TopBar
        active={active}
        onSelect={navigate}
        onOpenSettings={openSettings}
        onOpenPalette={openPalette}
        settingsOpen={settingsOpen}
      />
      <main className="relative z-10 flex-1 overflow-y-auto">
        {/* key remounts the tab so its entrance animation replays on switch */}
        {reviewPr ? (
          <div key={`review:${reviewPr.url}`}>
            <Review pr={reviewPr} onBack={() => setReviewPr(null)} />
          </div>
        ) : (
          <div key={activeTab.id}>{activeTab.render(ctx)}</div>
        )}
      </main>
      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        onNavigate={navigate}
        onOpenSettings={openSettings}
      />
      <SettingsDrawer open={settingsOpen} onClose={closeSettings} />
    </div>
  );
}

export default App;
