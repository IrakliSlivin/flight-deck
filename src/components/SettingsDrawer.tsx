import { openUrl } from "@tauri-apps/plugin-opener";
import { type ReactNode, useEffect, useState } from "react";
import {
  SOUNDS,
  getReminderSettings,
  previewNotificationSound,
  setReminderSettings,
  type ReminderSettings,
  type SoundId,
} from "../lib/reminders";
import { CLAUDE_CLI_KEY, checkClaudeCli, type ClaudeCliCheck } from "../lib/outlook";
import { CredentialField } from "./CredentialField";
import { CloseIcon } from "./Icons";

interface FieldDef {
  key: string;
  label: string;
  secret?: boolean;
}

export interface IntegrationDef {
  id: string;
  name: string;
  description: string;
  fields: FieldDef[];
  helpUrl?: string;
  instructions?: string[];
}

export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: "clickup",
    name: "ClickUp",
    description: "Powers the sprint tasks widget on Today.",
    fields: [
      { key: "clickup.api_token", label: "API Token" },
      {
        key: "clickup.space_name",
        label: "Space/Folder/List URL (optional)",
        secret: false,
      },
    ],
  },
  {
    id: "bitbucket",
    name: "Bitbucket",
    description:
      "Powers the PRs tab. Token scopes needed: read:pullrequest:bitbucket, read:user:bitbucket, read:repository:bitbucket.",
    fields: [
      { key: "bitbucket.email", label: "Atlassian Email", secret: false },
      { key: "bitbucket.api_token", label: "API Token" },
      {
        key: "bitbucket.workspace",
        label: "Workspace(s) (comma-separated)",
        secret: false,
      },
      {
        key: "bitbucket.repos",
        label: "Repos to watch (optional — blank scans all repos in the workspace)",
        secret: false,
      },
    ],
    helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    instructions: [
      'Open the link below, then click "Create API token with scopes" (not the plain "Create API token" button — that one has no scopes and won\'t work here).',
      'In the App dropdown, select "Bitbucket" explicitly. Skipping this is the most common mistake — no scope checkboxes for Bitbucket will appear until you do.',
      "Check these three scopes: read:pullrequest:bitbucket, read:user:bitbucket, and read:repository:bitbucket (the last one lets repos be auto-discovered so you don't have to list them).",
      "Create the token and copy it immediately — it's shown only once. Tokens can't be edited after creation, so if you already made one without this scope, make a new one.",
      "Enter the email you use to log into Bitbucket, the token, and your workspace slug(s) below (e.g. acme — the part right after bitbucket.org/ in your repo URLs). Listing the workspace directly avoids needing yet another scope just to look up which workspaces you belong to.",
      'Bitbucket no longer has an API for "PRs awaiting my review" across all repos — leave "Repos to watch" blank to scan every repo in the workspace, or list specific slugs (e.g. evex_billing) to narrow it down.',
    ],
  },
  {
    id: "gitlab",
    name: "GitLab",
    description:
      "Merge requests in the PRs tab, next to Bitbucket. Token scope needed: read_api.",
    fields: [
      { key: "gitlab.api_token", label: "Personal Access Token" },
      {
        key: "gitlab.base_url",
        label: "GitLab URL (optional — blank means https://gitlab.com)",
        secret: false,
      },
    ],
    helpUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
    instructions: [
      'Open the link below (on a self-hosted GitLab: avatar → Edit profile → Access tokens) and click "Add new token".',
      'Name it, pick an expiry date, and check only the "read_api" scope.',
      "Create the token, copy it (it's shown only once) and paste it below.",
      'If your GitLab is self-hosted, enter its address (e.g. https://gitlab.example.com). "Needs your review" lists open MRs where you are a reviewer and haven\'t approved yet.',
    ],
  },
  {
    id: "outlook-calendar",
    name: "Outlook Calendar",
    description: "Powers Meetings on Today, via your published calendar link (no app registration needed).",
    fields: [{ key: "outlook.calendar_ics_url", label: "Published calendar ICS link" }],
    instructions: [
      "In Outlook on the web: Settings → Calendar → Shared calendars → Publish a calendar.",
      'Pick your calendar, choose "Can view all details", and click Publish.',
      "Copy the ICS link (not the HTML one) and paste it below. Anyone with this link can read your calendar, so it's stored in the keyring.",
    ],
  },
];

/** Credential whose presence means the integration is set up. */
export const REQUIRED_KEY: Record<string, string> = {
  clickup: "clickup.api_token",
  bitbucket: "bitbucket.api_token",
  gitlab: "gitlab.api_token",
  "outlook-calendar": "outlook.calendar_ics_url",
};

const LEAD_OPTIONS = [1, 2, 5, 10, 15];

function Choice({
  selected,
  disabled,
  onClick,
  children,
}: {
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md px-2 py-1 font-mono text-[11px] transition disabled:opacity-40 ${
        selected ? "bg-amber-400 text-slate-900" : "bg-white/[0.06] text-slate-400 hover:bg-white/10 hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

/** Sound choices plus Off; picking a sound also plays a preview notification. */
function SoundPicker({
  label,
  on,
  sound,
  disabled,
  onChange,
  onError,
}: {
  label: string;
  on: boolean;
  sound: SoundId;
  disabled: boolean;
  onChange: (on: boolean, sound?: SoundId) => void;
  onError: (message: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-slate-300">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap justify-end gap-1">
        {SOUNDS.map((s) => (
          <Choice
            key={s.id}
            selected={on && sound === s.id}
            disabled={disabled}
            onClick={() => {
              onChange(true, s.id);
              previewNotificationSound(s.id).catch((e) => onError(String(e)));
            }}
          >
            {s.label}
          </Choice>
        ))}
        <Choice selected={!on} disabled={disabled} onClick={() => onChange(false)}>
          Off
        </Choice>
      </div>
    </div>
  );
}

function NotificationsSection() {
  const [settings, setSettings] = useState<ReminderSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getReminderSettings()
      .then(setSettings)
      .catch((e) => setError(String(e)));
  }, []);

  async function update(patch: Partial<ReminderSettings>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      await setReminderSettings(next);
      setError(null);
    } catch (e) {
      setSettings(settings);
      setError(String(e));
    }
  }

  const lead = settings?.lead_minutes ?? 5;
  return (
    <section
      className="rise flex flex-col gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4"
      style={{ animationDelay: "80ms" }}
    >
      <div>
        <h3 className="text-sm font-semibold text-slate-100">Notifications</h3>
        <p className="text-xs text-slate-400">
          Meetings {lead} min before they start, and new unread mail.
        </p>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-xs text-slate-300">Heads-up</span>
        <div role="radiogroup" aria-label="Reminder lead time" className="flex gap-1">
          {LEAD_OPTIONS.map((min) => (
            <Choice key={min} selected={lead === min} disabled={!settings} onClick={() => update({ lead_minutes: min })}>
              {min}m
            </Choice>
          ))}
        </div>
      </div>
      <SoundPicker
        label="Meeting sound"
        on={settings?.sound ?? false}
        sound={settings?.sound_name ?? "bell"}
        disabled={!settings}
        onChange={(on, id) => update(id ? { sound: on, sound_name: id } : { sound: on })}
        onError={setError}
      />
      <SoundPicker
        label="Email sound"
        on={settings?.mail_sound ?? false}
        sound={settings?.mail_sound_name ?? "chime"}
        disabled={!settings}
        onChange={(on, id) => update(id ? { mail_sound: on, mail_sound_name: id } : { mail_sound: on })}
        onError={setError}
      />
      {error && <p className="text-xs text-rose-400">{error}</p>}
    </section>
  );
}

function ClaudeCliSection() {
  const [check, setCheck] = useState<ClaudeCliCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function test() {
    setBusy(true);
    setCheck(null);
    setError(null);
    try {
      setCheck(await checkClaudeCli());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="rise flex flex-col gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4"
      style={{ animationDelay: "115ms" }}
    >
      <div>
        <h3 className="text-sm font-semibold text-slate-100">Claude CLI</h3>
        <p className="text-xs text-slate-400">
          Runs the AI mail brief on your Claude Code login. Leave blank for <code>claude</code>.
        </p>
      </div>
      <CredentialField
        fieldKey={CLAUDE_CLI_KEY}
        label="Command or path"
        secret={false}
      />
      <p className="text-xs text-slate-500">
        A full path (<code>~/.local/bin/claude-work</code>) or a name on PATH. Shell aliases don't
        work here — point at the script the alias runs. Save, then Check.
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={test}
          disabled={busy}
          className="label rounded-lg border border-white/10 px-3 py-1.5 !text-[11px] text-slate-300 transition hover:text-white disabled:opacity-40"
        >
          {busy ? "Checking…" : "Check"}
        </button>
        {check && (
          <span className="min-w-0 truncate text-xs text-emerald-300">
            {check.version} — {check.path}
          </span>
        )}
      </div>
      {error && <p className="text-xs text-rose-400">{error}</p>}
    </section>
  );
}

export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        style={{ animation: "fade-in .25s ease-out" }}
        onClick={onClose}
      />
      <aside
        className="glass relative flex h-full w-[min(560px,92vw)] flex-col !rounded-none !border-y-0 !border-r-0 !bg-[#0b1220]/95"
        style={{ animation: "drawer-in .35s cubic-bezier(.2,.8,.2,1)" }}
      >
        <header className="flex items-center justify-between border-b border-white/[0.06] px-6 py-4">
          <div>
            <h2 className="label text-slate-300">Settings</h2>
            <p className="mt-1 text-xs text-slate-400">Notifications, integrations &amp; credentials</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="rounded-full border border-white/10 p-1.5 text-slate-400 transition hover:rotate-90 hover:text-white"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
          <NotificationsSection />
          <ClaudeCliSection />
          {INTEGRATIONS.map((integration, i) => (
            <section
              key={integration.id}
              className="rise flex flex-col gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4"
              style={{ animationDelay: `${150 + i * 70}ms` }}
            >
              <div>
                <h3 className="text-sm font-semibold text-slate-100">{integration.name}</h3>
                <p className="text-xs text-slate-400">{integration.description}</p>
              </div>

              {integration.instructions && (
                <details className="group rounded-lg bg-black/20 p-3">
                  <summary className="label cursor-pointer list-none !text-[11px] text-slate-400 hover:text-slate-300">
                    <span className="inline-block transition group-open:rotate-90">▸</span> Setup steps
                  </summary>
                  <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-slate-400">
                    {integration.instructions.map((step, i) => (
                      <li key={i}>{step}</li>
                    ))}
                  </ol>
                  {integration.helpUrl && (
                    <button
                      onClick={() => openUrl(integration.helpUrl!)}
                      className="mt-2 text-xs font-medium text-amber-300 underline"
                    >
                      {integration.helpUrl}
                    </button>
                  )}
                </details>
              )}

              <div className="flex flex-col gap-2">
                {integration.fields.map((field) => (
                  <CredentialField
                    key={field.key}
                    fieldKey={field.key}
                    label={field.label}
                    secret={field.secret}
                  />
                ))}
              </div>
            </section>
          ))}
          <p className="font-mono text-[12px] text-slate-500">
            Saved to your OS keyring (Secret Service) — never written to plaintext config, and never
            leaves this machine.
          </p>
        </div>
      </aside>
    </div>
  );
}
