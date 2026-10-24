from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
from typing import Any

COLORS = {
    "pass": "#3a9d5d",
    "forbidden_contact": "#d1495b",
    "stalled": "#edae49",
    "timeout": "#8e6c8a",
    "other": "#66717e",
}
LEGEND = (
    ("pass", COLORS["pass"]),
    ("forbidden_contact", COLORS["forbidden_contact"]),
    ("stalled", COLORS["stalled"]),
    ("timeout", COLORS["timeout"]),
    ("other", COLORS["other"]),
)


def _format_axis(values: list[float]) -> str:
    return f"{values[0]:.4g} to {values[-1]:.4g}"


def render_svg(grid: dict[str, Any]) -> str:
    rows = int(grid["rows"])
    cols = int(grid["cols"])
    samples = grid["samples"]
    cell_width = 58
    cell_height = 34
    gap = 3
    left = 112
    top = 72
    grid_width = cols * cell_width + max(0, cols - 1) * gap
    grid_height = rows * cell_height + max(0, rows - 1) * gap
    legend_top = top + grid_height + 52
    width = max(left + grid_width + 36, left + len(LEGEND) * 122)
    height = legend_top + 44
    sha_prefix = html.escape(str(grid["controllerSha256"])[:12])
    pass_count = int(grid["summary"]["passCount"])
    n = int(grid["n"])
    title = f"Fuzz grid · controller {sha_prefix} · {pass_count}/{n} pass"
    x_axis = grid["axes"]["x"]
    y_axis = grid["axes"]["y"]
    x_label = (
        f'{html.escape(x_axis["key"])} '
        f'({_format_axis(x_axis["values"])})'
    )
    y_label = (
        f'{html.escape(y_axis["key"])} '
        f'({_format_axis(y_axis["values"])})'
    )
    lines = [
        (
            '<svg xmlns="http://www.w3.org/2000/svg" '
            f'width="{width}" height="{height}" viewBox="0 0 {width} {height}" '
            'role="img">'
        ),
        f"<title>{html.escape(title)}</title>",
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        (
            f'<text x="{left}" y="28" font-family="sans-serif" '
            f'font-size="16" font-weight="600">{html.escape(title)}</text>'
        ),
        (
            f'<text x="{left + grid_width / 2:.1f}" y="52" '
            'text-anchor="middle" font-family="sans-serif" font-size="12">'
            f"{x_label}</text>"
        ),
        (
            f'<text x="20" y="{top + grid_height / 2:.1f}" '
            'text-anchor="middle" font-family="sans-serif" font-size="12" '
            f'transform="rotate(-90 20 {top + grid_height / 2:.1f})">'
            f"{y_label}</text>"
        ),
    ]
    for index in range(rows * cols):
        row, col = divmod(index, cols)
        x = left + col * (cell_width + gap)
        y = top + row * (cell_height + gap)
        if index >= n:
            lines.append(
                f'<rect class="empty" x="{x}" y="{y}" width="{cell_width}" '
                f'height="{cell_height}" fill="none" stroke="#d8dde3"/>'
            )
            continue
        sample = samples[index]
        if sample["passed"]:
            outcome = "pass"
        else:
            failure_kind = sample.get("failureKind")
            outcome = failure_kind if failure_kind in COLORS else "other"
        lines.append(
            f'<rect class="sample" data-index="{index}" data-outcome="{outcome}" '
            f'x="{x}" y="{y}" width="{cell_width}" height="{cell_height}" '
            f'rx="3" fill="{COLORS[outcome]}"/>'
        )
        lines.append(
            f'<text x="{x + cell_width / 2}" y="{y + cell_height / 2 + 4}" '
            'text-anchor="middle" font-family="sans-serif" font-size="11" '
            f'fill="#ffffff">{index}</text>'
        )
    legend_x = left
    for label, color in LEGEND:
        lines.append(
            f'<circle cx="{legend_x + 5}" cy="{legend_top + 7}" r="5" '
            f'fill="{color}"/>'
        )
        lines.append(
            f'<text x="{legend_x + 15}" y="{legend_top + 11}" '
            'font-family="sans-serif" font-size="11">'
            f"{html.escape(label)}</text>"
        )
        legend_x += 122
    lines.append("</svg>")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m simulator.fuzz_svg")
    parser.add_argument("grid", type=Path)
    parser.add_argument("out", type=Path)
    args = parser.parse_args(argv)
    try:
        grid = json.loads(args.grid.read_text())
        svg = render_svg(grid)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(svg)
    except Exception as exc:  # noqa: BLE001
        parser.exit(2, f"{type(exc).__name__}: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
