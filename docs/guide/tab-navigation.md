# Tab Navigation

[English](tab-navigation.md) | [简体中文](zh-CN/tab-navigation.md) · [← Back to README](../../README.md)

---

vipper brings tiling-window-manager navigation into Chrome: **groups on one axis, tabs on the other** — the same mental model as switching workspaces and windows in Hyprland.

![Two-dimensional navigation](assets/tabnav.en.png)

## Key mapping

| Key | Action | Semantics |
|---|---|---|
| `Alt+↑` / `Alt+↓` | Previous / next **group** | Like switching workspaces |
| `Alt+Shift+←` / `Alt+Shift+→` | Previous / next **tab within the group** | Like switching windows |

> `Alt+←/→` is reserved by Chrome for history navigation and cannot be overridden by extensions — that's why the in-group keys carry `Shift`.

## Exact semantics

- **Groups are Chrome's native Tab Groups**, ordered by their visual left→right position in the tab bar, mapped to top→bottom.
- **Implicit groups**: a contiguous run of ungrouped tabs counts as one group. Two runs separated by a real group are two different implicit groups — navigation always matches what you see.
- **Per-group memory**: switching to a group activates the tab you last used in that group.
- **Fold as you go**: the target group expands, all other groups collapse.
- **No wrap-around**: pressing past the first/last group or tab does nothing.
- **Window-scoped**: only the current Chrome window is considered; other windows are untouched.

## Notes

- The four keys are preset via `chrome.commands` and work globally in the browser — no page focus required.
- Group switching works on any tab, grouped or not; the current group is derived from the active tab's position.
