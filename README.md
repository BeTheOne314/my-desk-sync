# My Desk Sync

An Obsidian plugin that syncs your knowledge notes between
[My Desk](https://my-desk-snowy.vercel.app) and your vault — **directly**, with no
GitHub repository and no personal access tokens to juggle.

Notes settled on your desk flow into your vault as Markdown you own; edits you make in
Obsidian flow back. Files use the same `10_WIKI/<uuid>.md` format as the older GitHub
route, so switching over needs no migration.

## Setup

1. Install the plugin (via the community store, or [BRAT](https://github.com/TfTHacker/obsidian42-brat) while it's in review — see below).
2. In My Desk, open **맞춤 설정 → 옵시디언 플러그인** and issue a plugin token.
3. In this plugin's settings, paste the token. Leave the address as-is unless you self-host.
4. Run **"지금 오가기"** from the command palette, or let it sync on the interval you set (5 min minimum).

Issuing a plugin token pauses the older GitHub sync for your account — a vault is only ever
driven by one path at a time. Your own `obsidian-git` backups are unaffected.

## How it syncs

A three-way merge over three snapshots: your local files, the server, and a baseline it
remembers from the last sync. This lets it tell a *new* note from a *deleted* one, and a
note *you* edited from one the server changed — so edits aren't silently overwritten.

- Conflicts (both sides changed) resolve toward the later edit; within one second, the local
  file wins, so a note you just touched in Obsidian is respected.
- A note deleted on the server moves your local file to the trash (recoverable).
- A file you delete locally is restored from the server on the next sync (nothing is lost).
- Frontmatter keys you add yourself (aliases, tags, …) are preserved.

## Requires

A My Desk 서재 subscription. Syncing and vault features are paid because they need an account
and a server — installing the plugin itself is free.

## Privacy

The plugin talks only to your My Desk address, and only when it syncs. It sends your knowledge
notes (the files in the configured folder) so the server can reconcile them. No analytics, no
telemetry, nothing sent anywhere else. Your token is stored in the vault's plugin data, like
any other plugin setting.

## Beta install (BRAT)

While the plugin is under community-store review you can install it with BRAT:

1. Install the **BRAT** community plugin.
2. BRAT → *Add beta plugin* → enter this repository's URL.
3. Enable **My Desk Sync** in *Community plugins*.

## Development

```bash
npm install
npm run dev      # esbuild watch → main.js
npm run build    # typecheck + production bundle
```

The three-way engine (`src/sync.ts`) and the Markdown format (`src/format.ts`) are pure and
covered by tests in the main repository.
