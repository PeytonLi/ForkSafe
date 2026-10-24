from __future__ import annotations

import ast


def _functions(source: str) -> dict[str, ast.AST]:
    tree = ast.parse(source)
    return {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def changed_functions(baseline_src: str, candidate_src: str) -> list[str]:
    baseline = _functions(baseline_src)
    candidate = _functions(candidate_src)
    changed = {
        name
        for name in baseline.keys() | candidate.keys()
        if name not in baseline
        or name not in candidate
        or ast.dump(baseline[name], include_attributes=False)
        != ast.dump(candidate[name], include_attributes=False)
    }
    baseline_module = ast.Module(
        body=[
            node
            for node in ast.parse(baseline_src).body
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        ],
        type_ignores=[],
    )
    candidate_module = ast.Module(
        body=[
            node
            for node in ast.parse(candidate_src).body
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        ],
        type_ignores=[],
    )
    if ast.dump(baseline_module, include_attributes=False) != ast.dump(
        candidate_module, include_attributes=False
    ):
        changed.add("<module>")
    return sorted(changed)
