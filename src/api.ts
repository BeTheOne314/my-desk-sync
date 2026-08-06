import { requestUrl } from "obsidian";

import type { Note } from "./format";

// 플래너(/api/vault/notes)와 대화하는 얇은 클라이언트.
// obsidian의 requestUrl을 쓰는 이유: fetch와 달리 CORS 제약을 받지 않고 데스크탑·모바일 모두에서
// 동작한다. 인증은 플러그인 토큰(mds_…) — supabase 세션이 아니다.

export type NoteIndexEntry = { id: string; updatedAt: string };
export type Category = { id: string; name: string };

export type NotesResponse = {
  serverTime: string;
  categories: Category[];
  index: NoteIndexEntry[];
  notes: Note[];
};

export type PushOutcome = { id: string; ok: boolean; updatedAt?: string; error?: string };
export type PushResponse = { serverTime: string; results: PushOutcome[] };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export class PlannerApi {
  constructor(
    private baseUrl: string,
    private token: string
  ) {}

  private notesUrl(since?: string): string {
    const base = `${trimTrailingSlash(this.baseUrl)}/api/vault/notes`;
    return since ? `${base}?since=${encodeURIComponent(since)}` : base;
  }

  // since 없으면 전체, 있으면 그 이후 변경분 + 항상 전체 index(삭제 감지용).
  async getNotes(since?: string): Promise<NotesResponse> {
    const res = await requestUrl({
      url: this.notesUrl(since),
      method: "GET",
      headers: { authorization: `Bearer ${this.token}` },
      throw: false
    });
    if (res.status >= 400) {
      throw new ApiError(res.status, errorOf(res.json, res.status));
    }
    return res.json as NotesResponse;
  }

  // 배치 upsert(≤100). 응답의 results[].updatedAt이 서버가 확정한 값(플러그인 baseline).
  async pushNotes(notes: Note[]): Promise<PushResponse> {
    const res = await requestUrl({
      url: this.notesUrl(),
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ notes }),
      throw: false
    });
    if (res.status >= 400) {
      throw new ApiError(res.status, errorOf(res.json, res.status));
    }
    return res.json as PushResponse;
  }

  // 연결 확인 — 토큰·URL이 유효하고 구독 자격이 있는지 빠르게 검사.
  async ping(): Promise<{ noteCount: number; categoryCount: number }> {
    const data = await this.getNotes();
    return { noteCount: data.index.length, categoryCount: data.categories.length };
  }
}

function errorOf(json: unknown, status: number): string {
  if (json && typeof json === "object" && "error" in json) {
    const e = (json as { error?: unknown }).error;
    if (typeof e === "string" && e) return e;
  }
  return `요청이 실패했어요 (HTTP ${status})`;
}
