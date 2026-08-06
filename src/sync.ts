import { notesEqual, type Note } from "./format";

// 3-way 동기화 판정 — 순수 함수. 로컬(L)·서버(S)·baseline(B) 셋을 겹쳐,
// 무엇을 밀고(push) 무엇을 파일로 쓰고(write) 무엇을 지울지(trash) 결정한다.
// obsidian 의존 없음 → vitest로 단독 검증한다(설계 §4.2 표를 그대로 구현).
//
// baseline = 마지막 동기화 시점의 각 노트 상태(서버 updatedAt + 로컬 콘텐츠 해시).
//   이게 있어야 "새로 생긴 것"과 "지워진 것", "한쪽만 바뀐 것"을 구분한다(커서만으론 불가).

export type BaselineEntry = { serverUpdatedAt: string; contentHash: string };
export type Baseline = Record<string, BaselineEntry>;

export type LocalNote = {
  id: string;
  record: Note;
  extraFrontmatter: Record<string, string>;
  contentHash: string;
  mtime: number; // 파일 수정 시각(ms) — 충돌 시 서버 updatedAt와 비교.
};

export type ServerIndexEntry = { id: string; updatedAt: string };

export type WriteOp = {
  note: Note; // 서버본을 파일로 쓴다.
  extra: Record<string, string>; // 기존 로컬 파일의 관리 외 frontmatter를 보존(F3).
};

export type SyncPlan = {
  push: Note[]; // 로컬 → 서버(배치 upsert)
  write: WriteOp[]; // 서버 → 로컬 파일(생성/덮어쓰기)
  trash: string[]; // 로컬 파일 휴지통 이동(서버에서 삭제된 것)
  forget: string[]; // baseline에서 제거(양쪽 다 사라짐)
  keep: Baseline; // 변화 없어 그대로 둘 baseline 항목(이미 올바름)
};

const CONFLICT_TIE_MS = 1000; // 이 안쪽 차이는 로컬 우선(옵시디언에서 막 만진 걸 존중).

export function planSync(input: {
  locals: LocalNote[];
  serverIndex: ServerIndexEntry[];
  serverNotes: Note[]; // since 이후 변경분(전문). 없는 id는 "서버에서 안 바뀜".
  baseline: Baseline;
}): SyncPlan {
  const { locals, serverIndex, serverNotes, baseline } = input;

  const localById = new Map(locals.map((l) => [l.id, l]));
  const serverUpdatedById = new Map(serverIndex.map((s) => [s.id, s.updatedAt]));
  const serverNoteById = new Map(serverNotes.map((n) => [n.id, n]));

  const plan: SyncPlan = { push: [], write: [], trash: [], forget: [], keep: {} };

  const allIds = new Set<string>([
    ...localById.keys(),
    ...serverUpdatedById.keys(),
    ...Object.keys(baseline)
  ]);

  for (const id of allIds) {
    const local = localById.get(id) ?? null;
    const onServer = serverUpdatedById.has(id);
    const serverUpdatedAt = serverUpdatedById.get(id) ?? null;
    const base = baseline[id] ?? null;

    // ── 존재 조합별 판정 ──────────────────────────────────────
    if (local && !onServer && !base) {
      // 새 로컬 노트 → 서버로.
      plan.push.push(local.record);
      continue;
    }
    if (!local && onServer && !base) {
      // 새 서버 노트 → 파일 생성.
      const note = serverNoteById.get(id);
      if (note) plan.write.push({ note, extra: {} });
      continue;
    }
    if (!local && onServer && base) {
      // 로컬에서 삭제됨(예전엔 있었음). MVP: 부활 — 서버본으로 다시 쓴다.
      const note = serverNoteById.get(id) ?? null;
      if (note) {
        plan.write.push({ note, extra: {} });
      } else {
        // 서버가 안 바뀌어 전문이 안 왔다 → 이번엔 baseline 유지, 다음 전체 동기화에서 복원.
        plan.keep[id] = base;
      }
      continue;
    }
    if (local && !onServer && base) {
      // 서버에서 삭제됨 → 로컬 파일 휴지통(복구 가능).
      plan.trash.push(id);
      continue;
    }
    if (local && onServer && !base) {
      // 둘 다 있는데 baseline 없음(첫 만남 — 예: GitHub 경로에서 이행). 내용 같으면 그냥 baseline만.
      const server = serverNoteById.get(id) ?? null;
      if (server && notesEqual(local.record, server)) {
        plan.keep[id] = {
          serverUpdatedAt: serverUpdatedAt ?? server.updatedAt,
          contentHash: local.contentHash
        };
      } else if (server) {
        resolveConflict(plan, local, server, serverUpdatedAt);
      } else {
        // 서버 전문이 안 왔다(안 바뀜) → 로컬을 서버로 밀어 일치시킨다(로컬이 진실측 우선).
        plan.push.push(local.record);
      }
      continue;
    }
    if (local && onServer && base) {
      const localChanged = local.contentHash !== base.contentHash;
      const serverChanged = (serverUpdatedAt ?? "") !== base.serverUpdatedAt;

      if (!localChanged && !serverChanged) {
        plan.keep[id] = base; // 양쪽 그대로.
      } else if (localChanged && !serverChanged) {
        plan.push.push(local.record); // 로컬만 바뀜 → 서버로.
      } else if (!localChanged && serverChanged) {
        const server = serverNoteById.get(id);
        if (server) plan.write.push({ note: server, extra: local.extraFrontmatter });
        else plan.keep[id] = base; // 전문 못 받음 — 다음 기회.
      } else {
        // 둘 다 바뀜 → 충돌.
        const server = serverNoteById.get(id) ?? null;
        if (server) resolveConflict(plan, local, server, serverUpdatedAt);
        else plan.push.push(local.record); // 서버 전문 없으면 일단 로컬을 민다.
      }
      continue;
    }

    // 남은 경우: !local && !onServer && base → 양쪽 다 사라짐 → baseline 정리.
    plan.forget.push(id);
  }

  return plan;
}

// 충돌: 1초 이내 차이는 로컬 우선, 아니면 늦은 쪽이 이긴다.
function resolveConflict(
  plan: SyncPlan,
  local: LocalNote,
  server: Note,
  serverUpdatedAt: string | null
): void {
  const serverTs = Date.parse(serverUpdatedAt ?? server.updatedAt);
  const localTs = local.mtime;

  const localWins =
    !Number.isFinite(serverTs) ||
    localTs - serverTs > -CONFLICT_TIE_MS; // 로컬이 같거나 더 늦거나, 1초 이내면 로컬.

  if (localWins) {
    plan.push.push(local.record);
  } else {
    plan.write.push({ note: server, extra: local.extraFrontmatter });
  }
}
