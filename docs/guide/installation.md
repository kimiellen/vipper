# Installation & Shortcuts

[English](installation.md) | [简体中文](zh-CN/installation.md) · [← Back to README](../../README.md)

---

## Load the extension

```bash
pnpm install
pnpm build        # output: .output/chrome-mv3
```

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select `.output/chrome-mv3`
4. After code changes: `pnpm build` again and click **reload** on the vipper card

## Bind the two manual shortcuts

The four tab-navigation keys work out of the box. Chrome caps each extension at 4 preset shortcuts, so these two need a one-time manual binding:

1. Open `chrome://extensions/shortcuts`
2. Find **vipper** and bind:
   - `打开书签管理器 / Open bookmark manager` → `Alt+.`
   - `在当前登录页填充账号密码 / Autofill` → `Alt+P`

## First run: create the master password

Press `Alt+.` — on first launch vipper asks you to create a master password. It encrypts all credentials and is **never stored**; there is no recovery. If you ever forget it, see [Security → Reset](security.md).

![Create master password](assets/unlock-create.en.png)

## Hyprland (Wayland): floating, centered popup

On Wayland the compositor owns window placement, so Chrome can't center the popup itself. vipper computes the window **size** from your monitor's work area (5/6 of it, clamped to 900×600 – 1600×900); Hyprland only needs to float + center it.

**The rule must match `class`, not the title.** A popup's `initialTitle` at map time is `_crx_<extension-id>`; the real title is set after load, so title rules always miss. The class `chrome-<extension-id>-Default` is known immediately.

**Do not set a `size` rule** — it would override vipper's per-monitor sizing.

Lua config (`hl.window_rule`, verified on Hyprland 0.56):

```lua
hl.window_rule({
	name = "vipper-float",
	match = { class = "^chrome-<extension-id>-Default$" },
	float = true,
	center = true,
})
```

Classic `hyprland.conf`:

```conf
windowrulev2 = float, class:^chrome-<extension-id>-Default$
windowrulev2 = center, class:^chrome-<extension-id>-Default$
```

> The id of an unpacked extension derives from the extension directory's **absolute path**. If the build path changes, the id changes — check the popup's actual `class` with `hyprctl clients` and update the rule.
>
> Troubleshooting: a wrong field type (e.g. `size` as a table) silently disables the **whole rule**. After `hyprctl reload`, reopen the popup and confirm `floating: 1` in `hyprctl clients`.

## Other platforms

No window rules needed — vipper opens a centered popup window sized proportionally to the display it was summoned from.
