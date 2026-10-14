#!/usr/bin/env python3
"""把 design-system/tokens.css 的内容同步进设计原型和扩展页面 html。

规则：
- tokens.css 是唯一真源；html 不引用它，而是在 <style> 内联完整 token 块。
- html 中的 token 块以 @tokens:start / @tokens:end 标记包裹，禁止手改。
- 本脚本扫描 docs/design/prototypes/ 和 entrypoints/ 下所有 html，把标记块替换为 tokens.css 当前内容。

用法：python3 scripts/sync-tokens.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOKENS = ROOT / "design-system" / "tokens.css"
TARGET_DIRS = [
    ROOT / "docs" / "design" / "prototypes",
    ROOT / "entrypoints",
]

PATTERN = re.compile(
    r"/\* ==== @tokens:start.*?@tokens:end ==== \*/",
    re.S,
)

MARKED_BLOCK_TEMPLATE = (
    "/* ==== @tokens:start 由 design-system/tokens.css 同步生成，请勿手改 ====\n"
    "{tokens}\n"
    "/* ==== @tokens:end ==== */"
)


def main() -> int:
    if not TOKENS.exists():
        print(f"错误：找不到 {TOKENS}", file=sys.stderr)
        return 1
    tokens = TOKENS.read_text(encoding="utf-8").strip()
    block = MARKED_BLOCK_TEMPLATE.format(tokens=tokens)

    changed, skipped, missing = [], [], []
    for d in TARGET_DIRS:
        if not d.exists():
            continue
        for f in sorted(d.rglob("*.html")):
            text = f.read_text(encoding="utf-8")
            new, n = PATTERN.subn(block, text)
            if not n:
                missing.append(f.relative_to(ROOT))
            elif new != text:
                f.write_text(new, encoding="utf-8")
                changed.append(f.relative_to(ROOT))
            else:
                skipped.append(f.relative_to(ROOT))

    for rel in changed:
        print(f"已同步  {rel}")
    for rel in skipped:
        print(f"无变化  {rel}")
    for rel in missing:
        print(f"警告：{rel} 缺少 @tokens 标记，已跳过", file=sys.stderr)
    print(f"\n共 {len(changed)} 个文件更新，{len(skipped)} 个已是最新，{len(missing)} 个缺标记")
    return 0


if __name__ == "__main__":
    sys.exit(main())
