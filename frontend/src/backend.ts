// Typed helpers for the FastAPI backend. All writes go through here;
// reads come straight from Convex.

import type { QuestionSource } from "./types";

const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ??
  "http://localhost:8000";

export class BackendError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new BackendError(`Can't reach the backend at ${API_URL}. Is it running?`);
  }
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const detail =
      data && typeof data === "object" && "detail" in data
        ? (data as { detail: unknown }).detail
        : data;
    const message =
      typeof detail === "string" ? detail : detail ? JSON.stringify(detail) : response.statusText;
    throw new BackendError(message || `Request failed (${response.status})`);
  }
  return data as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export type Health = {
  integrations: Record<string, boolean>;
  defaultPlatforms: string[];
  publicBaseUrl: string;
};

export type NewElder = {
  name: string;
  phone: string;
  expertise: string[];
  language: string;
  bio?: string;
};

export type NewQuestion = { title: string; body?: string; sourceUrl?: string };

export type RefreshOptions = { sources?: string[]; limit?: number };

export const backend = {
  health: () => request<Health>("/api/health"),
  createElder: (elder: NewElder) => post<{ elderId: string }>("/api/elders", elder),
  questionSources: () => request<QuestionSource[]>("/api/questions/sources"),
  refreshQuestions: (options: RefreshOptions = {}) =>
    post<Record<string, unknown>>("/api/questions/refresh", options),
  addQuestion: (q: NewQuestion) => post<Record<string, unknown>>("/api/questions/manual", q),
  routeQuestions: () => post<Record<string, unknown>>("/api/questions/route"),
  callElder: (elderId: string) => post<{ callSid: string }>("/api/calls/outbound", { elderId }),
  publish: (answerId: string, platforms: string[]) =>
    post<Record<string, unknown>>(`/api/answers/${answerId}/publish`, { platforms }),
  setAnswerStatus: (answerId: string, status: string) =>
    post<Record<string, unknown>>(`/api/answers/${answerId}/status`, { status }),
  addReply: (answerId: string, reply: { platform: string; author: string; text: string }) =>
    post<Record<string, unknown>>(`/api/answers/${answerId}/replies`, reply),
};
