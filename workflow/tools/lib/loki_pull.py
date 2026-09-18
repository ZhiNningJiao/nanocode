#!/usr/bin/env python3
"""Three-stage per-task Loki pull for taskid-trace.sh.

Drop-in for the CLI contract the trace script already speaks
(`loki_pull.py <task> --since 1h --out <newdir>`), but the transport is the
verbatim retab loki.py sitting next to this file (AIGW MCP,
~/.config/meshy-aigw.key) — one transport implementation, this file only
owns the task-id staging/CLI shell around it.
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import loki  # verbatim copy of ~/codex_work/retab/loki.py

# Line-text filters, not label matchers: production streams carry the task id
# in the log line / structured fields, and `{task_id="…"}` label selectors
# return zero rows (verified 2026-09-18 against a same-day staging task).
STAGES = [
    '{{namespace=~"meshy-serving.*"}} |= "{task}"',
    '{{namespace=~"meshy-serving.*"}} |= "{task}" |= "phase"',
    '{{namespace=~"meshy-serving.*"}} |= "parent" |= "{task}"',
]


def _validate(task):
    if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", task or ""):
        raise ValueError("task id must be a UUID-like token")
    return task


def _since_hours(text):
    match = re.fullmatch(r"(\d+)([smhd])", (text or "").strip())
    if not match:
        raise ValueError("--since must look like 30m / 1h / 2d")
    seconds = int(match.group(1)) * {"s": 1, "m": 60, "h": 3600, "d": 86400}[match.group(2)]
    if not 1 <= seconds <= 86400 * 30:
        raise ValueError("--since out of supported bounds")
    return seconds / 3600.0


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task")
    parser.add_argument("--since", default="1h")
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--out", required=True, help="new directory for stage logs")
    args = parser.parse_args(argv)
    try:
        task = _validate(args.task)
        hours = _since_hours(args.since)
    except ValueError as exc:
        print(json.dumps({"state": "invalid_input", "error": str(exc)}))
        return 2
    try:
        os.mkdir(args.out, mode=0o700)
    except FileExistsError:
        print(json.dumps({"state": "output_exists"}))
        return 2
    summary = []
    for index, template in enumerate(STAGES, start=1):
        logql = template.format(task=task)
        try:
            rows = loki.rows(logql, hours=hours, limit=min(args.limit, 5000))
        except Exception as exc:  # network/auth/MCP errors: fail loud, no partial "ok"
            print(json.dumps({"state": "loki_failed", "stage": index,
                              "selector": logql, "error": str(exc)[:400]}))
            return 2
        name = os.path.join(args.out, f"loki-stage-{index}.log")
        with open(name, "w", encoding="utf-8") as stream:
            stream.write("# selector: " + logql + "\n")
            for _ts, line, _labels in rows[: args.limit]:
                stream.write(line.rstrip("\n") + "\n")
        summary.append({"stage": index, "selector": logql, "lines": len(rows[: args.limit])})
    print(json.dumps({"state": "ok", "stages": summary}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
