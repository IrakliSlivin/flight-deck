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
