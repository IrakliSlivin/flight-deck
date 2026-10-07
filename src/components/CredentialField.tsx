import { useEffect, useState } from "react";
import {
  saveCredential,
  hasCredential,
  getCredential,
  deleteCredential,
} from "../lib/credentials";

export function CredentialField({
  fieldKey,
  label,
  secret = true,
  onSaved,
}: {
  fieldKey: string;
  label: string;
  secret?: boolean;
  /** Called with the new value after Save, or "" after Clear. */
  onSaved?: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (secret) {
      hasCredential(fieldKey)
        .then(setSaved)
        .catch(() => setSaved(false));
    } else {
      getCredential(fieldKey)
        .then((v) => {
          setValue(v ?? "");
          setSaved(!!v);
        })
        .catch(() => setSaved(false));
    }
  }, [fieldKey, secret]);

  async function handleSave() {
    if (!value) return;
    setBusy(true);
    try {
      await saveCredential(fieldKey, value);
      onSaved?.(value);
      if (secret) setValue("");
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    setBusy(true);
    try {
      await deleteCredential(fieldKey);
      onSaved?.("");
      setValue("");
      setSaved(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {label && <span className="w-40 shrink-0 text-xs text-slate-400">{label}</span>}
      <input
        type={secret ? "password" : "text"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSave()}
        placeholder={secret && saved ? "•••••••• saved" : "Not set"}
        className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-amber-300/50"
      />
      <button
        onClick={handleSave}
        disabled={busy || !value}
        className="label rounded-lg bg-slate-100 px-3 py-1.5 !text-[11px] text-slate-900 transition hover:bg-white disabled:opacity-30"
      >
        Save
      </button>
      {saved && (
        <button
          onClick={handleClear}
          disabled={busy}
          className="label rounded-lg border border-white/10 px-3 py-1.5 !text-[11px] text-slate-400 hover:text-rose-300"
        >
          Clear
        </button>
      )}
    </div>
  );
}
