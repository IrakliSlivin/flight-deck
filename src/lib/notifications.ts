import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** A meeting reminder or new-mail notification, as kept for the TopBar bell (notifications.rs). */
export interface FeedItem {
  id: number;
  kind: "email" | "meeting";
  title: string;
  body: string;
  /** Unix time in milliseconds. */
  at: number;
  /** Outlook conversation id (email) or join link (meeting). */
  target: string | null;
}

export function getNotificationFeed(): Promise<FeedItem[]> {
  return invoke("get_notification_feed");
}

/** Fires with the whole feed, newest first, whenever it changes. */
export function onNotificationFeed(handler: (items: FeedItem[]) => void): Promise<UnlistenFn> {
  return listen<FeedItem[]>("notification-feed", (e) => handler(e.payload));
}

export function dismissNotification(id: number): Promise<void> {
  return invoke("dismiss_notification", { id });
}

/** Empties the feed and closes any popups still up; returns how many were cleared. */
export function clearNotifications(): Promise<number> {
  return invoke("clear_notifications");
}
