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
import { getCredential } from "../lib/credentials";
import { CLAUDE_CLI_KEY, checkClaudeCli, type ClaudeCliCheck } from "../lib/outlook";
import { CredentialField } from "./CredentialField";
import { CloseIcon } from "./Icons";
import { IntegrationSetup } from "./IntegrationSetup";

interface FieldDef {
  key: string;
  label: string;
  /** Non-secret fields are read back into the form; secrets never are. */
  secret?: boolean;
  optional?: boolean;
  placeholder?: string;
  /** Hides the field behind a link with this text until it's clicked (or has a value). */
  advanced?: string;
}

export interface IntegrationDef {
  id: string;
  name: string;
  description: string;
  /** What you type. Everything else is picked after "Save & connect" succeeds. */
  fields: FieldDef[];
  /** Settings saved by the pickers, cleared on Disconnect too. */
  settingKeys?: string[];
  helpUrl?: string;
  /** Setup steps; a step with `scopes` lists the token scopes to check under its text. */
  instructions?: (string | { text: string; scopes: ScopeDef[] })[];
}

interface ScopeDef {
  name: string;
  /** Shown next to the scope. */
  note?: string;
  /** Lets the app write (comments, approvals): highlighted, since it's easy to miss. */
  write?: boolean;
}

export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: "clickup",
    name: "ClickUp",
    description: "Powers the sprint tasks widget on Today.",
    fields: [{ key: "clickup.api_token", label: "API token", placeholder: "pk_…" }],
    settingKeys: ["clickup.space_name"],
    helpUrl: "https://app.clickup.com/settings/apps",
    instructions: [
      'Open the link below (ClickUp → Settings → Apps) and click "Generate" under API Token.',
      "Paste it below and press Save & connect. You can then narrow the tasks to one space, folder or list.",
    ],
  },
  {
    id: "bitbucket",
    name: "Bitbucket",
    description: "Pull requests in the PRs tab.",
    fields: [
      { key: "bitbucket.email", label: "Atlassian email", secret: false, placeholder: "you@company.com" },
      { key: "bitbucket.api_token", label: "API token" },
    ],
    settingKeys: ["bitbucket.workspace", "bitbucket.repos"],
    helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    instructions: [
      'Open the link below and click "Create API token with scopes" (not the plain "Create API token" — that one has no scopes).',
      'Pick "Bitbucket" in the App dropdown; the scope checkboxes only appear after that.',
      {
        text: "Check these scopes:",
        scopes: [
          { name: "read:pullrequest:bitbucket" },
          { name: "read:user:bitbucket" },
          { name: "read:repository:bitbucket" },
          { name: "read:workspace:bitbucket", note: "pick your workspace from a list" },
          {
            name: "write:pullrequest:bitbucket",
            note: "comment, approve and request changes from a PR review",
            write: true,
          },
        ],
      },
      "Copy the token (it's shown only once), enter it with the email you log into Bitbucket with, and press Save & connect.",
    ],
  },
  {
    id: "gitlab",
    name: "GitLab",
    description: "Merge requests in the PRs tab, next to Bitbucket.",
    fields: [
      { key: "gitlab.api_token", label: "Access token", placeholder: "glpat-…" },
      {
        key: "gitlab.base_url",
        label: "GitLab URL",
        secret: false,
        optional: true,
        placeholder: "https://gitlab.example.com",
        advanced: "Self-hosted GitLab?",
      },
    ],
    helpUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
    instructions: [
      'Open the link below (self-hosted: avatar → Edit profile → Access tokens) and click "Add new token".',
      {
        text: "Check one scope, create the token, and paste it below:",
        scopes: [
          { name: "read_api", note: "enough to list merge requests" },
          { name: "api", note: "instead of read_api: comment and approve from a PR review", write: true },
        ],
      },
    ],
  },
  {
    id: "outlook-calendar",
    name: "Outlook Calendar",
    description: "Meetings on Today, via your published calendar link (no app registration needed).",
    fields: [{ key: "outlook.calendar_ics_url", label: "ICS link", placeholder: "https://outlook.office365.com/…/calendar.ics" }],
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

/** Just a Check button; the command/path field appears when the check fails or one is saved. */
function ClaudeCliSection() {
  const [check, setCheck] = useState<ClaudeCliCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState(false);

  useEffect(() => {
    getCredential(CLAUDE_CLI_KEY)
      .then((v) => setCustom(!!v))
      .catch(() => {});
  }, []);

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
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-100">Claude CLI</h3>
          <p className="text-xs text-slate-400">Runs the AI mail brief on your Claude Code login.</p>
        </div>
        <button
          onClick={test}
          disabled={busy}
          className="label shrink-0 rounded-lg border border-white/10 px-3 py-1.5 !text-[11px] text-slate-300 transition hover:text-white disabled:opacity-40"
        >
          {busy ? "Checking…" : "Check"}
        </button>
      </div>
      {check && (
        <p className="truncate text-xs text-emerald-300" title={check.path}>
          ✓ {check.version} — {check.path}
        </p>
      )}
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {(error || custom) && (
        <>
          <CredentialField
            fieldKey={CLAUDE_CLI_KEY}
            label="Command or path"
            secret={false}
            onSaved={(v) => {
              setCustom(!!v);
              test();
            }}
          />
          <p className="text-xs text-slate-500">
            A full path (<code>~/.local/bin/claude-work</code>) or a name on PATH; blank means{" "}
            <code>claude</code>. Shell aliases don't work here — point at the script the alias runs.
          </p>
        </>
      )}
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
                      <li key={i}>
                        {typeof step === "string" ? (
                          step
                        ) : (
                          <>
                            {step.text}
                            <ul className="mt-1 mb-1.5 flex flex-col gap-1">
                              {step.scopes.map((scope) => (
                                <li key={scope.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                  <code
                                    className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
                                      scope.write
                                        ? "border border-amber-300/40 bg-amber-300/10 text-amber-200"
                                        : "bg-white/[0.06] text-slate-200"
                                    }`}
                                  >
                                    {scope.name}
                                  </code>
                                  {scope.note && (
                                    <span className={scope.write ? "text-amber-200/80" : "text-slate-500"}>
                                      {scope.write && "✦ "}
                                      {scope.note}
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </li>
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

              <IntegrationSetup integration={integration} requiredKey={REQUIRED_KEY[integration.id]} />
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
