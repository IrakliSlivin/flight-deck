import { useEffect, useState } from "react";
import {
  discoverGitRepos,
  getGitStatsSettings,
  scanGitPath,
  setGitStatsSettings,
  type GitStatsSettings,
  type RepoCandidate,
} from "../lib/gitStats";

const SOURCE_LABEL: Record<string, string> = {
  claude: "Claude Code",
  jetbrains: "JetBrains",
  added: "added",
  missing: "missing",
};

const tildify = (path: string) => path.replace(/^\/(home|Users)\/[^/]+/, "~");

const INPUT =
  "min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-amber-300/50";
const BUTTON =
  "label rounded-lg bg-slate-100 px-3 py-1.5 !text-[11px] text-slate-900 transition hover:bg-white disabled:opacity-30";

/** Settings → Repositories: which local clones the Stats tab reads. */
export function RepositoriesSection() {
  const [settings, setSettings] = useState<GitStatsSettings | null>(null);
  const [candidates, setCandidates] = useState<RepoCandidate[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [path, setPath] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Collapsed to one line; the repo scan runs the first time it's opened.
  const [open, setOpen] = useState(false);

  /** Ticked repos first, then the most recently opened. Sorted only here, so rows don't jump when ticked. */
  async function rescan(repos = settings?.repos ?? []) {
    setScanning(true);
    try {
      const found = await discoverGitRepos();
      setCandidates(found.sort((a, b) => Number(repos.includes(b.path)) - Number(repos.includes(a.path))));
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    getGitStatsSettings()
      .then(setSettings)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (open && settings && candidates === null && !scanning) rescan(settings.repos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settings]);

  async function save(next: GitStatsSettings) {
    const prev = settings;
    setSettings(next);
    try {
      await setGitStatsSettings(next);
      setError(null);
    } catch (e) {
      setSettings(prev);
      setError(String(e));
    }
  }

  function toggle(repo: string) {
    if (!settings) return;
    const on = settings.repos.includes(repo);
    save({ ...settings, repos: on ? settings.repos.filter((r) => r !== repo) : [...settings.repos, repo] });
  }

  async function addPath() {
    if (!settings || !path.trim()) return;
    setBusy(true);
    try {
      const found = await scanGitPath(path);
      const next = {
        ...settings,
        repos: [...settings.repos, ...found.filter((r) => !settings.repos.includes(r))],
        manual: [...settings.manual, ...found.filter((r) => !settings.manual.includes(r))],
      };
      await save(next);
      setPath("");
      await rescan(next.repos);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function addEmail() {
    const value = email.trim();
    if (!settings || !value || settings.emails.includes(value)) return;
    save({ ...settings, emails: [...settings.emails, value] });
    setEmail("");
  }

  const selected = new Set(settings?.repos ?? []);
  const list = candidates ?? [];
  const repoEmails = Array.from(new Set(list.filter((c) => selected.has(c.path) && c.email).map((c) => c.email!)));

  const names = (settings?.repos ?? []).map((r) => r.split("/").pop());
  const summary = !settings
    ? ""
    : names.length === 0
      ? "none selected · Stats tab hidden"
      : `${names.length} selected · ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}`;

  return (
    <section
      className={`rise flex flex-col gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] ${open ? "p-4" : "px-4 py-2.5"}`}
      style={{ animationDelay: "430ms" }}
    >
      <div className="flex items-center justify-between gap-4">
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="group flex min-w-0 flex-1 items-baseline gap-2 text-left"
        >
          <span
            className={`text-[10px] text-slate-500 transition group-hover:text-slate-300 ${open ? "rotate-90" : ""}`}
          >
            ▸
          </span>
          <h3 className="shrink-0 text-sm font-semibold text-slate-100">Stats repositories</h3>
          {!open && <span className="truncate font-mono text-[11px] text-slate-500">{summary}</span>}
        </button>
        {open && (
          <button
            onClick={() => rescan()}
            disabled={scanning}
            className="label shrink-0 rounded-lg border border-white/10 px-3 py-1.5 !text-[11px] text-slate-300 transition hover:text-white disabled:opacity-40"
          >
            {scanning ? "Scanning…" : "Rescan"}
          </button>
        )}
      </div>

      {open && (
        <>
          <p className="-mt-2 text-xs text-slate-400">
            Only used by the Stats tab: your commits in these local clones, read with <code>git log</code>. Nothing leaves this machine.
          </p>

          {candidates === null ? (
            <p className="text-xs text-slate-500">Looking through Claude Code and JetBrains projects…</p>
          ) : list.length === 0 ? (
            <p className="text-xs text-slate-500">No repos found yet. Add a repo or a folder of repos below.</p>
          ) : (
            <>
              <p className="font-mono text-[11px] text-slate-500">
                {selected.size} of {list.length} selected
                {selected.size === 0 && " · tick at least one to show the Stats tab"}
              </p>
              <ul className="flex max-h-72 flex-col overflow-y-auto rounded-lg bg-black/20 py-1">
                {list.map((c) => (
                  <li key={c.path}>
                    <label className="flex cursor-pointer items-start gap-3 px-3 py-1.5 transition hover:bg-white/[0.04]">
                      <input
                        type="checkbox"
                        checked={selected.has(c.path)}
                        disabled={!settings}
                        onChange={() => toggle(c.path)}
                        className="mt-0.5 accent-amber-400"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="truncate text-sm text-slate-200">{c.name}</span>
                          {c.remote && (
                            <span className="truncate font-mono text-[10.5px] text-slate-500">{c.remote}</span>
                          )}
                        </span>
                        <span className="flex items-baseline justify-between gap-2 font-mono text-[10.5px] text-slate-500">
                          <span className="truncate" title={c.path}>
                            {tildify(c.path)}
                          </span>
                          <span className={`shrink-0 ${c.sources.includes("missing") ? "text-rose-300" : ""}`}>
                            {c.sources.map((s) => SOURCE_LABEL[s] ?? s).join(" · ")}
                          </span>
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="flex items-center gap-2">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addPath()}
              placeholder="~/Work/some-repo, or a folder of repos"
              className={INPUT}
            />
            <button onClick={addPath} disabled={busy || !path.trim() || !settings} className={BUTTON}>
              {busy ? "Adding…" : "Add"}
            </button>
          </div>

          {selected.size > 0 && (
            <div className="flex flex-col gap-2 border-t border-white/[0.06] pt-3">
              <p className="text-xs text-slate-400">Your commits are matched on these author emails:</p>
              <div className="flex flex-wrap gap-1.5">
                {repoEmails.map((e) => (
                  <span
                    key={e}
                    title="user.email in one of the repos"
                    className="rounded-md bg-white/[0.06] px-2 py-0.5 font-mono text-[11px] text-slate-300"
                  >
                    {e}
                  </span>
                ))}
                {settings?.emails.map((e) => (
                  <span
                    key={e}
                    className="flex items-center gap-1 rounded-md border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 font-mono text-[11px] text-amber-100"
                  >
                    {e}
                    <button
                      onClick={() => save({ ...settings, emails: settings.emails.filter((x) => x !== e) })}
                      aria-label={`Remove ${e}`}
                      className="text-amber-200/60 hover:text-rose-300"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addEmail()}
                  placeholder="Another email you commit with"
                  className={INPUT}
                />
                <button onClick={addEmail} disabled={!email.trim()} className={BUTTON}>
                  Add
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {error && <p className="text-xs text-rose-400">{error}</p>}
    </section>
  );
}
