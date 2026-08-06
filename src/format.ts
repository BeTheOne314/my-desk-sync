// wiki 노트 ↔ 마크다운(frontmatter + body) 변환 + 콘텐츠 해시.
//
// ⚠️ 서버의 lib/vault-format.ts와 같은 규약을 구현한다 — 두 벌이 갈라지면 데이터 손실이 된다.
//    한쪽을 고치면 반드시 다른 쪽도 맞출 것. (플러그인은 별도 빌드라 import 대신 포팅.)
// obsidian 등 런타임 의존 없음 — 순수 모듈이라 vitest로 서버와 나란히 검증한다.

export type NoteType =
  | "source"
  | "concept"
  | "question"
  | "decision"
  | "plan"
  | "playbook";

export type NoteStatus = "draft" | "active" | "superseded" | "archived";

export type Note = {
  id: string;
  title: string;
  noteType: string;
  categoryId: string | null;
  subtype: string;
  summary: string;
  body: string;
  status: string;
  derivedFromItemId: string | null;
  derivedFromDate: string | null;
  createdAt: string;
  updatedAt: string;
};

export const NOTE_TYPES: NoteType[] = [
  "source",
  "concept",
  "question",
  "decision",
  "plan",
  "playbook"
];

export const NOTE_STATUSES: NoteStatus[] = ["draft", "active", "superseded", "archived"];

const KNOWN_FRONTMATTER_KEYS = new Set([
  "id",
  "title",
  "note_type",
  "category_id",
  "category_name",
  "subtype",
  "summary",
  "status",
  "derived_from_item_id",
  "derived_from_date",
  "created_at",
  "updated_at"
]);

const FRONTMATTER_FIELDS = [
  "id",
  "title",
  "note_type",
  "category_id",
  "category_name",
  "subtype",
  "summary",
  "status",
  "derived_from_item_id",
  "derived_from_date",
  "created_at",
  "updated_at"
] as const;

export function isUuidLike(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    value
  );
}

export type SerializeOptions = {
  categoryName?: string | null;
  extraFrontmatter?: Record<string, string>;
};

export function serializeNote(record: Note, opts: SerializeOptions = {}): string {
  const meta: Record<string, string | null> = {
    id: record.id,
    title: record.title,
    note_type: record.noteType,
    category_id: record.categoryId ?? null,
    category_name: opts.categoryName ?? null,
    subtype: record.subtype ?? "",
    summary: record.summary ?? "",
    status: record.status,
    derived_from_item_id: record.derivedFromItemId ?? null,
    derived_from_date: record.derivedFromDate ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };

  const lines = ["---"];
  for (const key of FRONTMATTER_FIELDS) {
    lines.push(formatFrontmatterLine(key, meta[key]));
  }
  for (const [key, value] of Object.entries(opts.extraFrontmatter ?? {})) {
    if (KNOWN_FRONTMATTER_KEYS.has(key)) continue;
    lines.push(formatFrontmatterLine(key, value));
  }
  lines.push("---", "");

  const body = record.body?.trim() ? `${record.body.trim()}\n` : "";
  return `${lines.join("\n")}\n${body}`;
}

function formatFrontmatterLine(key: string, value: string | null): string {
  if (value === null || value === undefined) {
    return `${key}: null`;
  }
  const needsQuote = /[":#\n\r]/.test(value) || value !== value.trim();
  if (!needsQuote) {
    return `${key}: ${value}`;
  }
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return `${key}: "${escaped}"`;
}

export type ParsedNote = {
  record: Note;
  extraFrontmatter: Record<string, string>;
};

export function parseNote(fileId: string, content: string): ParsedNote | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return null;

  const meta = parseFrontmatter(match[1]);
  const body = match[2] ?? "";

  const id = meta.id ?? fileId;
  if (!isUuidLike(id)) return null;

  const title = meta.title ?? "";
  if (!title) return null;

  const noteType = (NOTE_TYPES as string[]).includes(meta.note_type) ? meta.note_type : "concept";
  const status = (NOTE_STATUSES as string[]).includes(meta.status) ? meta.status : "draft";
  const nowIso = new Date().toISOString();

  const record: Note = {
    id,
    title,
    noteType,
    categoryId: meta.category_id && meta.category_id !== "null" ? meta.category_id : null,
    subtype: meta.subtype ?? "",
    summary: meta.summary ?? "",
    body: body.trim(),
    status,
    derivedFromItemId:
      meta.derived_from_item_id && meta.derived_from_item_id !== "null"
        ? meta.derived_from_item_id
        : null,
    derivedFromDate:
      meta.derived_from_date && meta.derived_from_date !== "null" ? meta.derived_from_date : null,
    createdAt: meta.created_at ?? nowIso,
    updatedAt: meta.updated_at ?? nowIso
  };

  const extraFrontmatter: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(key)) extraFrontmatter[key] = value;
  }

  return { record, extraFrontmatter };
}

function parseFrontmatter(block: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    meta[key] = value;
  }
  return meta;
}

// 두 노트의 "내용"이 같은지 — 동기화 판정용(시각·category_name 제외).
export function notesEqual(a: Note, b: Note): boolean {
  return (
    a.title === b.title &&
    a.noteType === b.noteType &&
    (a.categoryId ?? null) === (b.categoryId ?? null) &&
    (a.subtype ?? "") === (b.subtype ?? "") &&
    (a.summary ?? "") === (b.summary ?? "") &&
    (a.body ?? "") === (b.body ?? "") &&
    a.status === b.status &&
    (a.derivedFromItemId ?? null) === (b.derivedFromItemId ?? null) &&
    (a.derivedFromDate ?? null) === (b.derivedFromDate ?? null)
  );
}

// 콘텐츠 해시 — 로컬 편집 감지용(보안 아님). FNV-1a 32bit. Node crypto 없이 모바일에서도 동작.
export function hashContent(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
