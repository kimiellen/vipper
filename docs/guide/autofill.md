# Autofill (Alt+P)

[English](autofill.md) | [简体中文](zh-CN/autofill.md) · [← Back to README](../../README.md)

---

On any login page, press `Alt+P`. vipper matches the page against your bookmarks' URL rules and fills username + password — Bitwarden-style, with a small ceremony: the username **types out character by character**, bounces, then the password does the same.

## Matching

Each bookmark URL carries a rule (editable in [edit mode](bookmarks.md#editing-in-place)):

| Rule | Matches when |
|---|---|
| `host` (default) | hostnames are equal (port/path/scheme ignored) |
| `exact` | origin + pathname are equal (query/hash ignored) |
| `prefix` | the page URL starts with the bookmark URL |

Archived entries never match. If nothing matches, nothing happens.

## Multiple accounts

When a bookmark has several accounts, an arrow-key picker appears in the page; it grabs keyboard focus (even when the login form lives in a cross-origin iframe) and hands it back on close:

![Account picker](assets/autofill-menu.en.png)

If the bookmark has several matching URLs… nothing extra to do — matching is by the current page, not by choosing a URL first.

## Fill feedback

- Per-character typing (≈20 ms per character, auto-compressed to a ~1 s budget per field), then a 200 ms scale bounce on the filled field — username first, password after
- `prefers-reduced-motion: reduce` disables both: values land instantly, with the final `input`/`change` events still dispatched (React/Vue controlled inputs work)
- If Chrome throttles timers (invisible cross-origin iframes get clamped to ~1 s), vipper detects the throttle and writes the remainder in one shot instead of degrading to 1 s per character

## Robustness details

- **Cross-origin iframes**: login forms inside frames (163 mail, Aliyun, Apple ID) are found by probing every frame; only the top frame shows menus and errors
- **Decoy fields**: only *visible* inputs count — hidden honeypot password boxes are never filled
- **Username anchoring**: when a password box exists, the username is the nearest visible text input before it in the same form — a page's search bar is never mistaken for it; `autocomplete="username/email"` still wins
- **Old tabs**: pages opened before an extension reload have no content script; vipper re-injects on demand — no refresh needed
- **Locked vault**: `Alt+P` opens the unlock page instead; unlock, come back, press `Alt+P` again

## Not covered by design

Content scripts can't run on `chrome://` pages, the New Tab page, or the Web Store.
