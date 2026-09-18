#!/usr/bin/env python3
"""Interim Loki range-query adapter for taskid-trace.

NOTE (taskid_tools_nanocode_1410): the taskbook asked for a verbatim source
copy of `~/codex_work/retab/loki.py` to be migrated into tools/lib/. That file
was not reachable from this lane (path absent in the sandbox); per WORKER_CORE
NEEDSIG discipline a NEEDSIG was filed and this minimal stdlib-only adapter
was written instead so the trace pipeline stays runnable end to end. When the
original loki.py is available, replace this file with that copy (keeping the
same `query_range()` entry point used by taskid-trace.sh) and delete this
interim adapter.

Credentials: read only from environment variables at call time
(LOKI_URL, LOKI_TOKEN). Nothing is stored in the repository.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_URL = "http://loki.monitoring.svc:3100"
# Three-stage selectors for a Meshy task trace: task id, task+phase, parent id.
# Stage 3 resolves parent at runtime; stage here is a template with {task}.
SELECTORS = [
    '{task_id="{task}"}',
    '{task_id="{task}"} |= "phase"',
    '{parent_task_id="{task}"}',
]


class LokiError(Exception):
    def __init__(self, state, message):
        self.state = state
        super().__init__(message)


def query_range(task, since="1h", limit=1000, timeout=30):
    """Run each selector as a Loki range query; return list of (name, lines)."""
    base = os.environ.get("LOKI_URL", DEFAULT_URL).rstrip("/")
    token = os.environ.get("LOKI_TOKEN", "").strip()
    seconds = _parse_since(since)
    end_ns = int(time.time() * 1e9)
    start_ns = end_ns - seconds * 1_000_000_000
    out = []
    for index, template in enumerate(SELECTORS):
        query = template.replace("{task}", _validate(task))
        url = (base + "/loki/api/v1/query_range?" + urllib.parse.urlencode(
            {"query": query, "start": start_ns, "end": end_ns,
             "limit": min(int(limit), 5000), "direction": "forward"}))
        request = urllib.request.Request(url)
        if token:
            request.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                doc = json.loads(response.read(16 * 1024 * 1024))
        except urllib.error.HTTPError as exc:
            raise LokiError("http_error", f"Loki stage {index} HTTP {exc.code}") from None
        except (urllib.error.URLError, OSError) as exc:
            raise LokiError("network", f"Loki stage {index} transport failed") from exc
        if doc.get("status") != "success":
            raise LokiError("invalid_response", f"Loki stage {index} not success")
        lines = []
        for stream in doc.get("data", {}).get("result", []):
            for value in stream.get("values", []):
                text = value[1] if len(value) > 1 else ""
                if isinstance(text, str) and len(text) < 8192:
                    lines.append(text)
        out.append({"stage": index, "selector": query, "lines": lines[:int(limit)]})
    return out


def _parse_since(value):
    match = re.fullmatch(r"([0-9]+)([smhd])", value.strip())
    if not match:
        raise LokiError("invalid_input", "--since must look like 30m, 24h, 7d")
    factor = {"s": 1, "m": 60, "h": 3600, "d": 86400}[match.group(2)]
    seconds = int(match.group(1)) * factor
    if not 1 <= seconds <= 86400 * 30:
        raise LokiError("invalid_input", "--since out of supported bounds")
    return seconds


def _validate(task):
    if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", task or ""):
        raise LokiError("invalid_input", "task id must be a UUID-like token")
    return task


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task")
    parser.add_argument("--since", default="1h")
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--out", required=True, help="new directory for stage logs")
    args = parser.parse_args(argv)
    try:
        os.mkdir(args.out, mode=0o700)
    except FileExistsError:
        print(json.dumps({"state": "output_exists"}))
        return 2
    try:
        stages = query_range(args.task, args.since, args.limit)
    except LokiError as exc:
        print(json.dumps({"state": exc.state, "error": str(exc)}))
        return 2
    for stage in stages:
        name = os.path.join(args.out, f"loki-stage-{stage['stage']}.log")
        with open(name, "w", encoding="utf-8") as stream:
            stream.write("# selector: " + stage["selector"] + "\n")
            for line in stage["lines"]:
                stream.write(line + "\n")
    summary = [{"stage": s["stage"], "selector": s["selector"], "lines": len(s["lines"])}
               for s in stages]
    print(json.dumps({"state": "ok", "stages": summary}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
