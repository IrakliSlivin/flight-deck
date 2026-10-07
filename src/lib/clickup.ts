import { invoke } from "@tauri-apps/api/core";

export interface ClickupTask {
  id: string;
  name: string;
  status: string;
  due_date: string | null;
  url: string;
  list_id: string;
  list_name: string;
}

export interface ClickupStatus {
  status: string;
  color: string;
  /** "open", "custom", "done" or "closed". */
  type: string;
  orderindex: number;
}

export function fetchClickupTasks(): Promise<ClickupTask[]> {
  return invoke("fetch_clickup_tasks");
}

/** A List's statuses, in board order. Cached in Rust for a week. */
export function fetchClickupListStatuses(listId: string): Promise<ClickupStatus[]> {
  return invoke("fetch_clickup_list_statuses", { listId });
}

export function updateClickupTaskStatus(taskId: string, listId: string, status: string): Promise<void> {
  return invoke("update_clickup_task_status", { taskId, listId, status });
}

export interface ClickupLocation {
  /** `space:<id>`, `folder:<id>` or `list:<id>`; saved as `clickup.space_name`. */
  value: string;
  name: string;
  kind: "space" | "folder" | "list";
  /** Parent names, outermost first. */
  path: string[];
}

export interface ClickupSetup {
  user: string;
  locations: ClickupLocation[];
}

/** Checks the saved token and lists the spaces, folders and lists it can see. */
export function checkClickup(): Promise<ClickupSetup> {
  return invoke("check_clickup");
}
