# PROVENANCE: verbatim source copy (upstream not modified; only this header prepended)
# upstream: /jfs/home/zhiningjiao/code/task-asset-fetch-0918/task_asset_msctl.py
# copied: 2026-09-18, task taskid_tools_nanocode_1410
# upstream_sha256: 996fe32a60457d0e94c9e6b0d50afc5155d43b80b294490678f38a57196d9821
"""Bounded msctl companion: explicit CLI-owned auth, no credential extraction."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import signal
import subprocess
import tempfile
import time

from task_asset_fetch import FetchError, safe_key, task_id, validate_file


class CLI:
    def __init__(self, executable, config_dir, profile, deadline):
        self.command = [executable, "--config-dir", config_dir, "--profile", profile, "tasks"]
        self.deadline = deadline

    def stream(self, operation, argument, sink, limit):
        """Bound stdout without buffering an asset; never echo CLI stderr/URLs."""
        total = 0
        proc = subprocess.Popen(self.command + [operation, argument], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                start_new_session=True)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(proc.stdout, selectors.EVENT_READ)
                while True:
                    left = self.deadline - time.monotonic()
                    if left <= 0:
                        raise FetchError("timeout", "total time budget exhausted")
                    if not selector.select(min(left, 0.25)):
                        continue
                    chunk = os.read(proc.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > limit:
                        raise FetchError("size_limit", "CLI output exceeds remaining byte budget")
                    sink(chunk)
            left = self.deadline - time.monotonic()
            if left <= 0:
                raise FetchError("timeout", "total time budget exhausted")
            try:
                result = proc.wait(timeout=left)
            except subprocess.TimeoutExpired:
                raise FetchError("timeout", "total time budget exhausted") from None
            if result:
                raise FetchError("cli_failed", "msctl failed; raw stderr suppressed; auth, route and object status not inferred")
            return total
        finally:
            # A dedicated process group bounds any descendants on failure, too.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
            proc.stdout.close()

    def info(self, task):
        data = bytearray()
        self.stream("info", task, data.extend, 4 * 1024 * 1024)
        try:
            doc = json.loads(data)
        except (ValueError, UnicodeError):
            raise FetchError("invalid_response", "msctl info did not return JSON") from None
        if not isinstance(doc, dict) or not any(k in doc for k in ("Args", "Mode", "Status")):
            raise FetchError("invalid_response", "msctl info lacks expected fields")
        return {k: doc[k] for k in ("Mode", "Phase", "Status", "CreatedAt", "StartedAt", "FinishedAt")
                if isinstance(doc.get(k), str) and re.fullmatch(r"[A-Za-z0-9_.:+ TZ-]{1,100}", doc[k])}


def retrieve(cli, task, key, target, limit):
    digest = hashlib.sha256()
    fd, name = tempfile.mkstemp(prefix=".partial-", dir=target.parent)
    partial = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            def consume(chunk):
                stream.write(chunk)
                digest.update(chunk)
            size = cli.stream("cat", task + "/" + key, consume, limit)
        validation = validate_file(partial, key)
        try:
            os.link(partial, target)
        except FileExistsError:
            raise FetchError("output_exists", "refusing to overwrite local output") from None
        return {"key": key, "local_file": target.name, "bytes": size,
                "sha256": digest.hexdigest(), "validation": validation, "role": "unverified"}
    finally:
        partial.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task")
    parser.add_argument("--source-task")
    parser.add_argument("--config-dir", required=True, help="explicit absolute auth directory; only msctl reads it")
    parser.add_argument("--profile", required=True, help="explicit existing CLI profile; no fallback")
    parser.add_argument("--msctl", default=str(Path(__file__).resolve().parent / "bin/msctl"))
    parser.add_argument("--key", action="append", default=[], help="explicit task-relative file; repeatable; omit for info only")
    parser.add_argument("--out", required=True)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--max-bytes", type=int, default=256 * 1024 * 1024)
    args = parser.parse_args(argv)
    manifest = {"state": "started", "backend": "official_msctl", "downloads": [],
                "role": "unverified", "real_asset_downloaded": False,
                "endpoint_verification": "delegated_to_explicit_cli_profile_not_independently_verified"}
    out = None
    previous = None
    active = False
    try:
        requested = task_id(args.task)
        source = task_id(args.source_task) if args.source_task else requested
        if not Path(args.config_dir).is_absolute() or not Path(args.msctl).is_absolute():
            raise FetchError("invalid_input", "--config-dir and --msctl must be absolute paths")
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", args.profile):
            raise FetchError("invalid_input", "invalid explicit profile name")
        if not (1 <= args.timeout <= 1800 and 1 <= args.max_bytes <= 2**31 and len(args.key) <= 100):
            raise FetchError("invalid_input", "limits outside supported bounds")
        for key in args.key:
            safe_key(key)
            if key.endswith("/"):
                raise FetchError("invalid_input", "--key must name a file")
        def timeout(_signum, _frame):
            raise FetchError("timeout", "total time budget exhausted")
        previous = signal.signal(signal.SIGALRM, timeout)
        signal.setitimer(signal.ITIMER_REAL, args.timeout)
        active = True
        candidate = Path(args.out).absolute()
        try:
            candidate.mkdir(mode=0o700, parents=False, exist_ok=False)
        except FileExistsError:
            raise FetchError("output_exists", "--out already exists; no files changed") from None
        out = candidate
        manifest.update(requested_task=requested, source_task=source, profile=args.profile,
                        source_lineage="explicit_unverified" if args.source_task else "same_task",
                        started_at_utc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        cli = CLI(args.msctl, args.config_dir, args.profile, time.monotonic() + args.timeout)
        manifest["task_info"] = cli.info(source)
        remaining = args.max_bytes
        for index, key in enumerate(args.key):
            target = out / (f"asset-{index:03d}" + PurePosixPath(key).suffix.lower())
            item = retrieve(cli, source, key, target, remaining)
            manifest["downloads"].append(item)
            remaining -= item["bytes"]
        manifest["state"] = "downloaded" if args.key else "inspected"
        manifest["real_asset_downloaded"] = bool(manifest["downloads"])
        code = 0
    except FetchError as exc:
        manifest.update(state=exc.state, error=str(exc))
        code = 2
    except OSError:
        manifest.update(state="local_io_error", error="local file or CLI launch operation failed")
        code = 2
    finally:
        if active:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)
    if out is not None:
        manifest["ended_at_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        try:
            with (out / "manifest.json").open("x", encoding="utf-8") as stream:
                json.dump(manifest, stream, indent=2, ensure_ascii=False)
                stream.write("\n")
        except OSError:
            manifest.update(state="local_io_error", error="could not publish manifest")
            code = 2
    print(json.dumps({"state": manifest["state"], "error": manifest.get("error"),
                      "download_count": len(manifest["downloads"])}))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
