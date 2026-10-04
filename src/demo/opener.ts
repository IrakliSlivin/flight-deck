// Stands in for @tauri-apps/plugin-opener in demo mode.
export async function openUrl(url: string): Promise<void> {
  window.open(url, "_blank", "noopener");
}
