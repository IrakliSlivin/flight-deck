import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { checkBitbucket, listBitbucketRepos, type BitbucketSetup } from "../lib/bitbucket";
import { fetchMeetings } from "../lib/calendar";
import { checkClickup, type ClickupSetup } from "../lib/clickup";
import { deleteCredential, getCredential, hasCredential, saveCredential } from "../lib/credentials";
import { checkGitlab } from "../lib/gitlab";
import { CredentialField } from "./CredentialField";
import type { IntegrationDef } from "./SettingsDrawer";

type Status =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; text: string }
  | { kind: "error"; text: string };

const INPUT =
  "min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-amber-300/50";

/** Saves a non-secret setting, or removes it when blank. */
function storeSetting(key: string, value: string): Promise<void> {
  return value.trim() ? saveCredential(key, value.trim()) : deleteCredential(key);
}

/**
 * Every field of one integration with a single "Save & connect": it saves what changed, then
 * runs `check` against the saved credentials and shows who you're connected as. Linked
 * integrations are checked when the drawer opens. `children` (the pickers) render once a
 * check has succeeded.
 */
function IntegrationForm({
  integration,
  requiredKey,
  check,
  onReset,
  children,
}: {
  integration: IntegrationDef;
  /** The credential whose presence means the integration is linked. */
  requiredKey: string;
  /** Resolves to the success line ("Connected as …"); rejects with the problem. */
  check: () => Promise<string>;
  /** Called on Disconnect, so the pickers drop what the last check found. */
  onReset?: () => void;
  children?: ReactNode;
}) {
  const fields = integration.fields;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [stored, setStored] = useState<Record<string, string | boolean>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const runCheck = useCallback(async () => {
    setStatus({ kind: "checking" });
    try {
      setStatus({ kind: "ok", text: await check() });
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
    }
  }, [check]);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      fields.map(async (f) =>
        f.secret === false
          ? [f.key, (await getCredential(f.key).catch(() => null)) ?? ""]
          : [f.key, await hasCredential(f.key).catch(() => false)],
      ),
    ).then((entries) => {
      if (cancelled) return;
      const loaded = Object.fromEntries(entries) as Record<string, string | boolean>;
      setStored(loaded);
      setDrafts(Object.fromEntries(fields.map((f) => [f.key, f.secret === false ? (loaded[f.key] as string) : ""])));
      if (loaded[requiredKey]) runCheck();
    });
    return () => {
      cancelled = true;
    };
    // Only on mount: the drawer remounts this every time it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changed = fields.filter((f) =>
    f.secret === false ? (drafts[f.key] ?? "").trim() !== (stored[f.key] || "") : !!drafts[f.key],
  );
  const linked = !!stored[requiredKey];
  const missing = fields.filter((f) => !f.optional && !stored[f.key] && !(drafts[f.key] ?? "").trim());

  async function save() {
    setBusy(true);
    try {
      const next = { ...stored };
      for (const f of changed) {
        const value = (drafts[f.key] ?? "").trim();
        if (f.secret === false) {
          await storeSetting(f.key, value);
          next[f.key] = value;
        } else {
          await saveCredential(f.key, value);
          next[f.key] = true;
        }
      }
      setStored(next);
      setDrafts((d) => Object.fromEntries(fields.map((f) => [f.key, f.secret === false ? d[f.key] ?? "" : ""])));
      if (next[requiredKey] && !fields.some((f) => !f.optional && !next[f.key])) {
        await runCheck();
      } else {
        setStatus({ kind: "idle" });
      }
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      for (const key of [...fields.map((f) => f.key), ...(integration.settingKeys ?? [])]) {
        await deleteCredential(key);
      }
      setStored({});
      setDrafts({});
      setStatus({ kind: "idle" });
      onReset?.();
    } finally {
      setBusy(false);
    }
  }

  const visible = fields.filter((f) => !f.advanced || showAdvanced || stored[f.key]);
  const hidden = fields.filter((f) => !visible.includes(f));

  return (
    <div className="flex flex-col gap-2">
      {visible.map((f) => (
        <label key={f.key} className="flex items-center gap-2">
          <span className="w-36 shrink-0 text-xs text-slate-400">{f.label}</span>
          <input
            type={f.secret === false ? "text" : "password"}
            value={drafts[f.key] ?? ""}
            onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && changed.length > 0 && !busy && save()}
            placeholder={f.secret !== false && stored[f.key] ? "•••••••• saved" : f.placeholder ?? "Not set"}
            className={INPUT}
          />
        </label>
      ))}
      {hidden.map((f) => (
        <button
          key={f.key}
          onClick={() => setShowAdvanced(true)}
          className="self-start text-xs text-slate-500 underline decoration-dotted hover:text-slate-300"
        >
          {f.advanced}
        </button>
      ))}

      <div className="flex min-h-7 items-center gap-2">
        <button
          onClick={changed.length > 0 ? save : runCheck}
          disabled={busy || status.kind === "checking" || (changed.length === 0 && !linked) || missing.length > 0}
          className="label shrink-0 rounded-lg bg-slate-100 px-3 py-1.5 !text-[11px] text-slate-900 transition hover:bg-white disabled:opacity-30"
        >
          {linked && changed.length === 0 ? "Test" : "Save & connect"}
        </button>
        {linked && (
          <button
            onClick={disconnect}
            disabled={busy}
            className="label shrink-0 rounded-lg border border-white/10 px-3 py-1.5 !text-[11px] text-slate-400 hover:text-rose-300"
          >
            Disconnect
          </button>
        )}
        <StatusLine status={status} />
      </div>
      {status.kind === "ok" && children}
    </div>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === "checking") return <span className="text-xs text-slate-400">Checking…</span>;
  if (status.kind === "ok")
    return <span className="min-w-0 truncate text-xs text-emerald-300">✓ {status.text}</span>;
  if (status.kind === "error")
    return <span className="min-w-0 break-words text-xs text-rose-400">{status.text}</span>;
  return null;
}

function PickerRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-36 shrink-0 pt-1.5 text-xs text-slate-400">{label}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>
    </div>
  );
}

/** Loads a setting once and saves it on every change. */
function useSetting(key: string) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getCredential(key)
      .then((v) => setValue(v ?? ""))
      .catch(() => setValue(""));
  }, [key]);
  const update = useCallback(
    (next: string) => {
      setValue(next);
      storeSetting(key, next)
        .then(() => setError(null))
        .catch((e) => setError(String(e)));
    },
    [key],
  );
  return [value, update, error] as const;
}

const csv = (raw: string | null) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// --- ClickUp: pick a space, folder or list instead of pasting its URL.

function ClickupLocationPicker({ setup }: { setup: ClickupSetup }) {
  const [value, setValue, error] = useSetting("clickup.space_name");
  if (value === null) return null;
  const known = setup.locations.some((l) => l.value === value);
  // Paths start with the workspace name when there are several.
  const offset = setup.locations.find((l) => l.kind === "space")?.path.length ?? 0;
  return (
    <PickerRow label="Show tasks from">
      <select value={value} onChange={(e) => setValue(e.target.value)} className={INPUT}>
        <option value="">Everywhere (all my tasks)</option>
        {value && !known && <option value={value}>Saved earlier: {value}</option>}
        {setup.locations.map((l) => {
          const depth = l.kind === "space" ? 0 : l.path.length - offset;
          const team = l.kind === "space" && l.path.length ? `${l.path[0]} / ` : "";
          return (
            <option key={l.value} value={l.value}>
              {"   ".repeat(depth)}
              {team}
              {l.name}
              {l.kind === "space" ? "" : ` (${l.kind})`}
            </option>
          );
        })}
      </select>
      {error && <p className="text-xs text-rose-400">{error}</p>}
    </PickerRow>
  );
}

function ClickupIntegration(props: SetupProps) {
  const [setup, setSetup] = useState<ClickupSetup | null>(null);
  const check = useCallback(async () => {
    const s = await checkClickup();
    setSetup(s);
    return `Connected as ${s.user}`;
  }, []);
  return (
    <IntegrationForm {...props} check={check} onReset={() => setSetup(null)}>
      {setup && <ClickupLocationPicker setup={setup} />}
    </IntegrationForm>
  );
}

// --- Bitbucket: pick workspaces and repos from what the token can see.

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      role="checkbox"
      aria-checked={on}
      onClick={onClick}
      className={`rounded-md px-2 py-1 font-mono text-[11px] transition ${
        on ? "bg-amber-400 text-slate-900" : "bg-white/[0.06] text-slate-400 hover:bg-white/10 hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

function BitbucketPickers({ setup }: { setup: BitbucketSetup }) {
  const [workspaceRaw, setWorkspaceRaw, wsError] = useSetting("bitbucket.workspace");
  const [reposRaw, setReposRaw, repoError] = useSetting("bitbucket.repos");
  const [typedWorkspace, setTypedWorkspace] = useState<string | null>(null);
  const [repos, setRepos] = useState<string[] | null>(null);
  const [reposFailed, setReposFailed] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const selected = useMemo(() => csv(typedWorkspace ?? workspaceRaw), [typedWorkspace, workspaceRaw]);
  const watched = csv(reposRaw);

  // With a single workspace there's nothing to choose: fill it in.
  useEffect(() => {
    if (workspaceRaw === "" && setup.workspaces?.length === 1) setWorkspaceRaw(setup.workspaces[0]);
  }, [workspaceRaw, setup.workspaces, setWorkspaceRaw]);

  const key = selected.join(",");
  useEffect(() => {
    if (!key) {
      setRepos(null);
      return;
    }
    let cancelled = false;
    setRepos(null);
    setReposFailed(null);
    Promise.all(key.split(",").map(listBitbucketRepos))
      .then((lists) => !cancelled && setRepos([...new Set(lists.flat())].sort()))
      .catch((e) => !cancelled && setReposFailed(String(e)));
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (workspaceRaw === null || reposRaw === null) return null;

  const toggleWorkspace = (slug: string) =>
    setWorkspaceRaw((selected.includes(slug) ? selected.filter((s) => s !== slug) : [...selected, slug]).join(","));
  const toggleRepo = (slug: string) =>
    setReposRaw((watched.includes(slug) ? watched.filter((s) => s !== slug) : [...watched, slug]).join(","));
  const shown = [...new Set([...watched, ...(repos ?? [])])]
    .filter((r) => r.toLowerCase().includes(filter.toLowerCase()))
    .sort();

  return (
    <>
      <PickerRow label="Workspace">
        {setup.workspaces && setup.workspaces.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {setup.workspaces.map((slug) => (
              <Chip key={slug} on={selected.includes(slug)} onClick={() => toggleWorkspace(slug)}>
                {slug}
              </Chip>
            ))}
          </div>
        ) : (
          <>
            <CredentialField
              fieldKey="bitbucket.workspace"
              label=""
              secret={false}
              onSaved={(v) => setTypedWorkspace(v)}
            />
            <p className="text-xs text-slate-500">
              {setup.workspaces
                ? "This account isn't in any workspace."
                : "Type the slug from bitbucket.org/<slug>/…, or add the read:workspace:bitbucket scope to the token to pick it from a list."}
            </p>
          </>
        )}
        {wsError && <p className="text-xs text-rose-400">{wsError}</p>}
      </PickerRow>

      {selected.length > 0 && (
        <PickerRow label="Repos to watch">
          <div className="flex items-center gap-2">
            <Chip on={watched.length === 0} onClick={() => setReposRaw("")}>
              All repos
            </Chip>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={repos ? `Filter ${repos.length} repos…` : "Loading repos…"}
              className={`${INPUT} !py-1 !text-xs`}
            />
          </div>
          {reposFailed && <p className="text-xs text-rose-400">{reposFailed}</p>}
          {shown.length > 0 && (
            <div className="flex max-h-40 flex-wrap content-start gap-1 overflow-y-auto">
              {shown.map((slug) => (
                <Chip key={slug} on={watched.includes(slug)} onClick={() => toggleRepo(slug)}>
                  {slug}
                </Chip>
              ))}
            </div>
          )}
          <p className="text-xs text-slate-500">
            "Needs your review" scans these. All repos is simplest; pick a few if it's slow.
          </p>
          {repoError && <p className="text-xs text-rose-400">{repoError}</p>}
        </PickerRow>
      )}
    </>
  );
}

function BitbucketIntegration(props: SetupProps) {
  const [setup, setSetup] = useState<BitbucketSetup | null>(null);
  const check = useCallback(async () => {
    const s = await checkBitbucket();
    setSetup(s);
    return `Connected as ${s.user}`;
  }, []);
  return (
    <IntegrationForm {...props} check={check} onReset={() => setSetup(null)}>
      {setup && <BitbucketPickers setup={setup} />}
    </IntegrationForm>
  );
}

// --- GitLab and the calendar only need their check.

const checkGitlabLine = async () => `Connected as ${await checkGitlab()}`;

async function checkCalendarLine() {
  const meetings = await fetchMeetings();
  const n = meetings.length;
  return `Calendar link works (${n} meeting${n === 1 ? "" : "s"} today and tomorrow)`;
}

interface SetupProps {
  integration: IntegrationDef;
  requiredKey: string;
}

export function IntegrationSetup(props: SetupProps) {
  switch (props.integration.id) {
    case "clickup":
      return <ClickupIntegration {...props} />;
    case "bitbucket":
      return <BitbucketIntegration {...props} />;
    case "gitlab":
      return <IntegrationForm {...props} check={checkGitlabLine} />;
    default:
      return <IntegrationForm {...props} check={checkCalendarLine} />;
  }
}
