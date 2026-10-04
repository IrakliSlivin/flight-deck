import { invoke } from "@tauri-apps/api/core";

export function saveCredential(key: string, value: string): Promise<void> {
  return invoke("save_credential", { key, value });
}

export function hasCredential(key: string): Promise<boolean> {
  return invoke("has_credential", { key });
}

// Only used for fields marked non-secret (email, workspace, repo slugs) —
// actual secrets (API tokens/keys) are never read back into the UI.
export function getCredential(key: string): Promise<string | null> {
  return invoke("get_credential", { key });
}

export function deleteCredential(key: string): Promise<void> {
  return invoke("delete_credential", { key });
}
