import { invoke } from "@tauri-apps/api/core";

export interface ReminderSettings {
  /** Meeting reminder sound. */
  sound: boolean;
  sound_name: SoundId;
  /** New-mail sound. */
  mail_sound: boolean;
  mail_sound_name: SoundId;
  /** Minutes before the start that the heads-up fires (1–60). */
  lead_minutes: number;
}

/** Must match `SOUNDS` in notifications.rs. */
export const SOUNDS = [
  { id: "chime", label: "Chime" },
  { id: "blip", label: "Blip" },
  { id: "bell", label: "Bell" },
] as const;

export type SoundId = (typeof SOUNDS)[number]["id"];

export function getReminderSettings(): Promise<ReminderSettings> {
  return invoke("get_reminder_settings");
}

export function setReminderSettings(settings: ReminderSettings): Promise<void> {
  return invoke("set_reminder_settings", { settings });
}

/** Shows a test notification with the given sound. */
export function previewNotificationSound(sound: SoundId): Promise<void> {
  return invoke("preview_notification_sound", { sound });
}
