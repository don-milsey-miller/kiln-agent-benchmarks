#!/usr/bin/env python3
"""Emit a compact, transcript-free status summary for an MS4 remote run."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def read_events(path: Path) -> tuple[dict[str, Any] | None, int, int, str]:
    last_assistant = None
    assistant_turns = 0
    errors = 0
    last_event = ""
    with path.open(encoding="utf-8", errors="replace") as source:
        for line in source:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            last_event = str(event.get("type", ""))
            if event.get("type") != "message_end":
                continue
            message = event.get("message") or {}
            if message.get("role") != "assistant":
                continue
            assistant_turns += 1
            last_assistant = message
            if message.get("stopReason") == "error":
                errors += 1
    return last_assistant, assistant_turns, errors, last_event


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    args = parser.parse_args()

    runs = args.root / "runs"
    for path in sorted(runs.glob("*/agent.jsonl")):
        last, turns, errors, last_event = read_events(path)
        usage = (last or {}).get("usage") or {}
        summary = {
            "run": path.parent.name,
            "bytes": path.stat().st_size,
            "assistantTurns": turns,
            "errors": errors,
            "lastEvent": last_event,
            "lastStop": (last or {}).get("stopReason"),
            "lastTokens": usage.get("totalTokens"),
            "complete": (path.parent / "remote.json").exists(),
        }
        print(json.dumps(summary, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
