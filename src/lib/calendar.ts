import { invoke } from "@tauri-apps/api/core";

export interface Meeting {
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string | null;
  join_url: string | null;
  busy_status: string | null;
}

/** Meetings from local midnight today through end of tomorrow. */
export function fetchMeetings(): Promise<Meeting[]> {
  return invoke("fetch_meetings");
}

