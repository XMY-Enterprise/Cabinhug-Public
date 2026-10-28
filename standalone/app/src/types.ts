// 宿主状态与命令载荷的形状，与 src-tauri/src/lib.rs、standalone/host 的 serde 输出一一对应。

export type Phase = "idle" | "needs-credentials" | "starting" | "ready" | "failed" | "stopping" | "stopped";

export interface HostStep {
  id: string;
  label: string;
  state: "waiting" | "running" | "done" | "failed";
  detail: string | null;
}

export interface HostStatus {
  phase: Phase;
  steps: HostStep[];
  message: string | null;
  missingCredentials: string[];
  logDir: string;
}

export interface CredentialField {
  env: string;
  label: string;
}

export interface CredentialGroup {
  group: string;
  label: string;
  fields: CredentialField[];
  saved: boolean;
}

export interface Verdict {
  ok: boolean;
  reason: string | null;
}

export interface ClientConfig {
  amapJsKey: string | null;
  amapSecurityCode: string | null;
}

/** `GET /v1/sessions` 的一行（`@cabinhug/db` 的 `userSessionPage`）。 */
export interface SessionItem {
  sessionId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  messageCount: number;
}
