import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { clearNotifications } from "../lib/notifications";
import { TABS, TabId } from "../tabs";

interface PaletteItem {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  onNavigate,
  onOpenSettings,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (id: TabId) => void;
  onOpenSettings: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo<PaletteItem[]>(
    () => [
      ...TABS.map((tab) => ({
        id: tab.id,
        label: `Go to ${tab.label}`,
        hint: "tab",
        run: () => onNavigate(tab.id),
      })),
      { id: "settings", label: "Open Settings", hint: "ctrl ,", run: onOpenSettings },
      { id: "clear-notifications", label: "Clear notifications", hint: "", run: () => void clearNotifications() },
      { id: "quit", label: "Quit Flight Deck", hint: "ctrl q", run: () => invoke("quit_app") },
    ],
    [onNavigate, onOpenSettings],
  );

  const filtered = items.filter((item) =>
    item.label.toLowerCase().includes(query.toLowerCase()),
  );

  useEffect(() => {
    if (open) {
      setQuery("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && open) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-32 backdrop-blur-[2px]"
      style={{ animation: "fade-in .15s ease-out" }}
      onClick={onClose}
    >
      <div
        className="rise glass w-full max-w-lg overflow-hidden rounded-2xl !bg-[#0b1220]/95"
        style={{ animationDuration: ".3s" }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && filtered[0]) {
              filtered[0].run();
              onClose();
            }
          }}
          placeholder="Jump to…"
          className="w-full border-b border-white/[0.06] bg-transparent px-4 py-3.5 font-mono text-sm text-slate-100 outline-none placeholder:text-slate-500"
        />
        <ul className="max-h-72 overflow-y-auto py-1">
          {filtered.map((item) => (
            <li key={item.id}>
              <button
                onClick={() => {
                  item.run();
                  onClose();
                }}
                className="flex w-full items-center justify-between px-4 py-2 text-left text-sm text-slate-200 transition hover:bg-white/[0.05] hover:text-amber-100"
              >
                <span>{item.label}</span>
                <span className="label !text-[11px] text-slate-500">{item.hint}</span>
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-4 py-3 text-sm text-slate-400">No matches</li>
          )}
        </ul>
      </div>
    </div>
  );
}
