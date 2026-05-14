#!/usr/bin/env python3
"""Parse nested LLM JSON and print the inner analysis object.

Input may be:

- Full wrapper: ``{"output": "<stringified inner JSON>"}``
- Fragment (missing outer braces), as saved by some tools::
    ``"output": "<stringified inner JSON>"``
- Already-expanded inner JSON (object with ``transaction_rules``, no ``output``).

Paths are resolved relative to the PlanAdvisorAPI project root (parent of this
``scripts/`` directory) when the input path is relative, so e.g.::

    data/documents/crew_response.json

works regardless of the current working directory.

Optional: convert string "null" to JSON null (common LLM artifact).

Usage (from anywhere)::

    python3 scripts/parse_nested_output.py data/documents/wrapper.json
    python3 scripts/parse_nested_output.py data/documents/wrapper.json -o data/documents/parsed.json
    python3 scripts/parse_nested_output.py --nullify data/documents/wrapper.json -o data/documents/parsed.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
API_ROOT = SCRIPT_DIR.parent


def prepare_outer_json_text(raw: str) -> str:
    """Return text that parses as one JSON object.

    Accepts:
    - Full wrapper: ``{"output": "<stringified inner>"}``
    - Common fragment (missing outer braces): ``"output": "<stringified inner>"``
    """
    text = raw.lstrip("\ufeff").strip()
    if text.startswith("{"):
        return text
    if re.match(r'^"output"\s*:', text):
        return "{" + text + "}"
    return text


def parse_inner_payload(data: object) -> object:
    """From parsed top-level JSON, return the inner analysis object."""
    if not isinstance(data, dict):
        raise SystemExit("Expected a JSON object at the top level.")

    out = data.get("output")
    if isinstance(out, str):
        return json.loads(out)
    if isinstance(out, dict):
        return out
    if "output" not in data and "transaction_rules" in data:
        return data

    raise SystemExit(
        'Expected either {"output": "<stringified JSON>"}, '
        '"output": "<stringified JSON>" (fragment), '
        'or the inner object with a "transaction_rules" array.'
    )


def nullify(x: object) -> object:
    if x == "null":
        return None
    if isinstance(x, dict):
        return {k: nullify(v) for k, v in x.items()}
    if isinstance(x, list):
        return [nullify(v) for v in x]
    return x


def resolve_input_path(raw: str) -> Path:
    p = Path(raw)
    if p.is_absolute():
        return p.resolve()
    return (API_ROOT / p).resolve()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "input_file",
        help='JSON file: {"output":"..."}, "output":"..." fragment, or inner object (path relative to PlanAdvisorAPI or absolute).',
    )
    p.add_argument(
        "-o",
        "--output",
        metavar="FILE",
        help="Write pretty-printed inner JSON here; default is stdout.",
    )
    p.add_argument(
        "--nullify",
        action="store_true",
        help='Replace string "null" with JSON null recursively.',
    )
    args = p.parse_args()

    in_path = resolve_input_path(args.input_file)
    if not in_path.is_file():
        raise SystemExit(f"Input file not found: {in_path}")

    text = in_path.read_text(encoding="utf-8")
    outer = json.loads(prepare_outer_json_text(text))
    inner = parse_inner_payload(outer)
    if args.nullify:
        inner = nullify(inner)

    out_payload = json.dumps(inner, indent=2, ensure_ascii=False) + "\n"

    if args.output:
        out_path = resolve_input_path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(out_payload, encoding="utf-8")
    else:
        sys.stdout.write(out_payload)


if __name__ == "__main__":
    main()
