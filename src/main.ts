import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from "obsidian";

import { ApiError, PlannerApi } from "./api";
import { hashContent, parseNote, serializeNote, type Note } from "./format";
import { HOME_PLANNER_URL, migratePlannerUrl } from "./planner-url";
import { planSync, type Baseline, type LocalNote } from "./sync";

// My Desk Sync — 옵시디언 vault와 My Desk를 GitHub 없이 직접 잇는 플러그인.
// Phase C: 3-way 동기화(파일 I/O + 순수 엔진 planSync + 서버 배치 push).

interface MyDeskSyncSettings {
  plannerUrl: string;
  token: string;
  folder: string;
  intervalMinutes: number; // 0이면 수동만. 최소 5.
  lastSyncedAt: string | null;
  lastResult: string;
  // 동기화 상태 — 마지막 동기화 시점의 각 노트 기준선 + 서버 커서.
  baseline: Baseline;
  cursor: string | null;
}

const DEFAULT_SETTINGS: MyDeskSyncSettings = {
  plannerUrl: HOME_PLANNER_URL,
  token: "",
  folder: "10_WIKI",
  intervalMinutes: 15,
  lastSyncedAt: null,
  lastResult: "",
  baseline: {},
  cursor: null
};

const MIN_INTERVAL = 5;
const PUSH_BATCH = 100;

export default class MyDeskSyncPlugin extends Plugin {
  settings: MyDeskSyncSettings = { ...DEFAULT_SETTINGS };
  private statusBar: HTMLElement | null = null;
  private intervalId: number | null = null;
  private syncing = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBar = this.addStatusBarItem();
    this.renderStatus();

    this.addCommand({
      id: "sync-now",
      name: "지금 오가기 (My Desk와 동기화)",
      callback: () => void this.syncNow(false)
    });

    this.addSettingTab(new MyDeskSyncSettingTab(this.app, this));
    this.scheduleInterval();
  }

  onunload(): void {
    this.clearIntervalTimer();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // 예전 기본 주소를 저장해 둔 설치본은 집(.com)으로 옮긴다. 다음 저장 때 디스크에도 남는다.
    this.settings.plannerUrl = migratePlannerUrl(this.settings.plannerUrl);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.scheduleInterval();
    this.renderStatus();
  }

  scheduleInterval(): void {
    this.clearIntervalTimer();
    const minutes = this.settings.intervalMinutes;
    if (!minutes || minutes < MIN_INTERVAL) return;
    this.intervalId = window.setInterval(() => void this.syncNow(true), minutes * 60_000);
    this.registerInterval(this.intervalId);
  }

  private clearIntervalTimer(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private api(): PlannerApi | null {
    if (!this.settings.plannerUrl || !this.settings.token) return null;
    return new PlannerApi(this.settings.plannerUrl, this.settings.token);
  }

  private folder(): string {
    return this.settings.folder.replace(/\/+$/, "") || "10_WIKI";
  }

  // ── 실제 3-way 동기화 ──────────────────────────────────────────
  async syncNow(silent: boolean): Promise<void> {
    if (this.syncing) return;
    const api = this.api();
    if (!api) {
      if (!silent) new Notice("My Desk: 주소와 토큰을 먼저 설정해 주세요.");
      return;
    }

    this.syncing = true;
    this.renderStatus("오가는 중…");
    try {
      const locals = await this.readLocalNotes();
      const localById = new Map(locals.map((l) => [l.id, l]));

      const server = await api.getNotes(this.settings.cursor ?? undefined);
      const categoryNameById = new Map(server.categories.map((c) => [c.id, c.name]));

      const plan = planSync({
        locals,
        serverIndex: server.index,
        serverNotes: server.notes,
        baseline: this.settings.baseline
      });

      const nextBaseline: Baseline = { ...plan.keep };

      // 서버 → 로컬 파일(생성/덮어쓰기). 기존 관리 외 frontmatter는 planSync가 op.extra로 넘겨 보존.
      for (const op of plan.write) {
        const hash = await this.writeNoteFile(op.note, op.extra, categoryNameById);
        nextBaseline[op.note.id] = { serverUpdatedAt: op.note.updatedAt, contentHash: hash };
      }

      // 서버에서 삭제된 것 → 로컬 파일 휴지통(복구 가능).
      for (const id of plan.trash) {
        await this.trashNoteFile(id);
      }

      // 로컬 → 서버(배치). 서버가 확정한 updatedAt을 baseline에 기록.
      let pushed = 0;
      let pushErrors = 0;
      for (let i = 0; i < plan.push.length; i += PUSH_BATCH) {
        const batch = plan.push.slice(i, i + PUSH_BATCH);
        const res = await api.pushNotes(batch);
        for (const r of res.results) {
          if (r.ok && r.updatedAt) {
            const local = localById.get(r.id);
            nextBaseline[r.id] = {
              serverUpdatedAt: r.updatedAt,
              contentHash: local ? local.contentHash : ""
            };
            pushed += 1;
          } else {
            pushErrors += 1; // baseline 미갱신 → 다음 동기화에서 재시도.
          }
        }
      }

      this.settings.baseline = nextBaseline;
      this.settings.cursor = server.serverTime;
      this.settings.lastSyncedAt = new Date().toISOString();
      this.settings.lastResult =
        `↓${plan.write.length} ↑${pushed} · 지움 ${plan.trash.length}` +
        (pushErrors > 0 ? ` · 실패 ${pushErrors}` : "");
      await this.saveData(this.settings);

      if (!silent) {
        new Notice(`My Desk와 오갔어요 — ${this.settings.lastResult}`);
      }
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "My Desk에 닿지 못했어요.";
      this.settings.lastResult = `실패: ${message}`;
      if (!silent) new Notice(`My Desk: ${message}`);
    } finally {
      this.syncing = false;
      this.renderStatus();
    }
  }

  // 폴더 안 md 파일 중 파일명이 uuid인 것을 읽어 로컬 상태로 만든다.
  private async readLocalNotes(): Promise<LocalNote[]> {
    const prefix = `${this.folder()}/`;
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(prefix));

    const out: LocalNote[] = [];
    for (const file of files) {
      const content = await this.app.vault.read(file);
      const parsed = parseNote(file.basename, content);
      if (!parsed) continue; // uuid 아님·frontmatter 없음 → 우리 노트가 아니다.
      out.push({
        id: parsed.record.id,
        record: parsed.record,
        extraFrontmatter: parsed.extraFrontmatter,
        contentHash: hashContent(content),
        mtime: file.stat.mtime
      });
    }
    return out;
  }

  // 서버 노트를 파일로 쓴다(폴더 없으면 만든다). 쓴 내용의 해시를 돌려준다(baseline용).
  private async writeNoteFile(
    note: Note,
    extra: Record<string, string>,
    categoryNameById: Map<string, string>
  ): Promise<string> {
    const folder = this.folder();
    await this.ensureFolder(folder);

    const path = `${folder}/${note.id}.md`;
    const categoryName = note.categoryId ? categoryNameById.get(note.categoryId) ?? null : null;
    const content = serializeNote(note, { categoryName, extraFrontmatter: extra });

    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(path, content);
    }
    return hashContent(content);
  }

  private async trashNoteFile(id: string): Promise<void> {
    const path = `${this.folder()}/${id}.md`;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.fileManager.trashFile(file); // 사용자 휴지통 설정을 따른다(복구 가능).
    }
  }

  private async ensureFolder(folder: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(folder);
    if (existing instanceof TFolder) return;
    try {
      await this.app.vault.createFolder(folder);
    } catch {
      // 이미 있거나 경쟁 상태 — 무시.
    }
  }

  private renderStatus(override?: string): void {
    if (!this.statusBar) return;
    if (override) {
      this.statusBar.setText(`My Desk: ${override}`);
      return;
    }
    this.statusBar.setText(
      this.settings.lastResult ? `My Desk: ${this.settings.lastResult}` : "My Desk"
    );
  }
}

class MyDeskSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: MyDeskSyncPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("p", {
      text: "My Desk의 맞춤 설정 → 옵시디언 플러그인에서 토큰을 발급해 아래에 붙여넣으세요."
    });

    new Setting(containerEl)
      .setName("My Desk 주소")
      .setDesc("보통 그대로 두면 됩니다. 자가 호스팅일 때만 바꾸세요.")
      .addText((text) =>
        text
          .setPlaceholder(HOME_PLANNER_URL)
          .setValue(this.plugin.settings.plannerUrl)
          .onChange(async (value) => {
            this.plugin.settings.plannerUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("플러그인 토큰")
      .setDesc("mds_ 로 시작하는 토큰. 화면에는 가려 보입니다.")
      .addText((text) => {
        text
          .setPlaceholder("mds_…")
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("노트 폴더")
      .setDesc("지식 노트를 둘 vault 안 폴더.")
      .addText((text) =>
        text
          .setPlaceholder("10_WIKI")
          .setValue(this.plugin.settings.folder)
          .onChange(async (value) => {
            this.plugin.settings.folder = value.trim() || "10_WIKI";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("자동 동기화 주기(분)")
      .setDesc("0이면 수동으로만. 최소 5분.")
      .addText((text) =>
        text
          .setPlaceholder("15")
          .setValue(String(this.plugin.settings.intervalMinutes))
          .onChange(async (value) => {
            const n = Number(value);
            this.plugin.settings.intervalMinutes = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("연결 확인")
      .setDesc("지금 My Desk에 닿는지 확인합니다(오가지는 않아요).")
      .addButton((btn) =>
        btn.setButtonText("연결 확인").onClick(async () => {
          const api =
            this.plugin.settings.plannerUrl && this.plugin.settings.token
              ? new PlannerApi(this.plugin.settings.plannerUrl, this.plugin.settings.token)
              : null;
          if (!api) {
            new Notice("My Desk: 주소와 토큰을 먼저 설정해 주세요.");
            return;
          }
          try {
            const { noteCount, categoryCount } = await api.ping();
            new Notice(`이어졌어요 — 지식 ${noteCount} · 갈래 ${categoryCount}`);
          } catch (e) {
            new Notice(`My Desk: ${e instanceof ApiError ? e.message : "닿지 못했어요."}`);
          }
        })
      );

    new Setting(containerEl)
      .setName("지금 오가기")
      .setDesc("놓인 지식을 지금 한 번 주고받습니다.")
      .addButton((btn) =>
        btn.setButtonText("지금 오가기").onClick(() => void this.plugin.syncNow(false))
      );

    if (this.plugin.settings.lastResult) {
      containerEl.createEl("p", { text: `상태: ${this.plugin.settings.lastResult}` });
    }
  }
}
