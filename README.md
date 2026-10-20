<div align="center">
  <img src="assets/vipper.svg" alt="vipper logo" width="96" height="96">
  <h1>vipper</h1>
  <p><strong>A tab switcher · bookmark manager · password &amp; info keeper for Chrome</strong></p>
  <p>
    <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/license-MIT-a6e3a1" alt="MIT License">
    <img src="https://img.shields.io/badge/chrome-MV3-89b4fa" alt="Chrome MV3">
    <img src="https://img.shields.io/badge/WXT-TypeScript-cba6f7" alt="WXT + TypeScript">
    <img src="https://img.shields.io/badge/crypto-WebCrypto%20only-f9e2af" alt="WebCrypto only">
  </p>
</div>

![vipper manager UI](docs/guide/assets/main.en.png)

vipper is a Chrome Manifest V3 extension that combines two everyday tools in one keyboard-first package:

1. **Tab switcher** — two-dimensional navigation across tab groups (↑/↓ between groups, ←/→ within a group), inspired by tiling window managers like Hyprland
2. **Bookmark + password manager** — an encrypted vault for bookmarks, accounts, and private notes, fully independent of Chrome's built-in systems, with one-key autofill and automatic save-on-login

Everything is driven by four-arrow-key thinking: open, search, fill, and organize without leaving the keyboard.

## Features

**Tab switcher**

- `Alt+H/L` switches **tab groups**; `Alt+J/K` switches tabs **within a group**
- A contiguous run of ungrouped tabs acts as an implicit group — plain tabs join the navigation too
- Each group remembers its last-active tab; switching collapses all other groups
- No wrap-around, scoped to the current window — multiple Chrome windows never interfere

**Bookmark + password manager**

- `Alt+.` toggles the manager window: search, multi-select TAGS/LINS filters, details, and in-place editing in one view
- Search covers name / URL / remarks, plus **Chinese pinyin** (initials and full spelling): `yh` finds 银行, `tb` finds 淘宝
- `Alt+P` fills credentials on a login page, Bitwarden-style, with per-character typing and a field bounce animation
- Multiple URLs per bookmark with `host / exact / prefix` match rules; multiple accounts per bookmark with an arrow-key picker
- **Save-on-login**: submit a login form and vipper offers to create the entry or append the new account — one click, encrypted on save
- Free-form records per bookmark: plain `note` and encrypted `secret` (recovery codes, API keys, …)
- Tags with Catppuccin colors and linked infos (phone / email / WeChat) are reference-safe: entries in use can't be deleted
- Archive old entries (manual or auto after N days), import/export as JSON for git-friendly backups
- Catppuccin Mocha/Latte themes and 中文/English UI

## Security model

- Master password + **PBKDF2-SHA256 (600k iterations)** + **AES-GCM**, WebCrypto only — zero third-party crypto dependencies
- Only `account.password` and `secret.content` are ciphertext; everything else stays searchable plaintext
- The key **lives in `chrome.storage.session` only** — never persisted; the vault locks on every browser restart
- Credentials captured at login live in service-worker memory only, and are discarded silently when locked
- No "forgot password" backdoor by design — see [Security](docs/guide/security.md)

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+H` / `Alt+L` | Switch to previous / next tab group |
| `Alt+J` / `Alt+K` | Switch tab within the group |
| `Alt+.` | Toggle the manager window (bind once, see installation) |
| `Alt+P` | Fill credentials on the current login page (bind once) |

> Chrome caps an extension at 4 preset shortcuts, so `Alt+.` and `Alt+P` are bound manually in `chrome://extensions/shortcuts` — a one-time, 30-second step.

## Installation

```bash
pnpm install
pnpm build
```

Then load `.output/chrome-mv3` via `chrome://extensions` → Developer mode → **Load unpacked**, and bind the two shortcuts.

Full walkthrough — including the Hyprland window rules that make the popup float and center on Wayland: **[Installation guide](docs/guide/installation.md)**

## User guide

Everyday operations, one page each, with screenshots:

- [Installation & shortcuts](docs/guide/installation.md) — load the extension, bind keys, Hyprland rules
- [Tab navigation](docs/guide/tab-navigation.md) — the two-dimensional model and its exact semantics
- [Bookmark manager](docs/guide/bookmarks.md) — search, pinyin, filters, opening, in-place editing
- [Autofill (Alt+P)](docs/guide/autofill.md) — match rules, multi-account picker, iframe logins
- [Save on login](docs/guide/auto-save.md) — the save/append prompt after you log in
- [Tags, linked infos & archive](docs/guide/organization.md) — keeping the vault tidy
- [Backup: import & export](docs/guide/backup.md) — plaintext JSON, full-restore semantics
- [Settings](docs/guide/settings.md) — theme, language, generators, lock & archive policies
- [Security model](docs/guide/security.md) — encryption details and password reset

## Development

```bash
pnpm dev          # WXT dev server with HMR
pnpm build        # production build → .output/chrome-mv3
pnpm typecheck    # strict tsc
```

Milestone-level acceptance scripts live in `scripts/` (CDP-driven, run against headless Chromium). The illustrated guide screenshots are reproducible via `node scripts/docs-shot.mjs`.

## License

[MIT](LICENSE) © 2026 kimiellen
