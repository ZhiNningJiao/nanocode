#!/usr/bin/env python3
"""
waker_core.py — V4 全量巡查 (full-sweep historian) external waker for the
secretary claude session.

V1 built the injection channel (wake-secretary.py, WS claude-input) — verified.
V2 made it smart (busy-gate + signal-driven + rate-limited).
V3 upgraded the injected content to a structured "史官简报" briefing.
V4 (master's final spec, 2026-07-15 night) replaces V3's passive "有货才叫"
(only speak when there's news) with an ACTIVE FULL-SWEEP every tick:

  1. EVERY TICK = FULL SWEEP: for each task in the coverage list, read its
     think-chain tail (loop log / tmux pane) -> one-line judgment (minutes-since-
     last-output / last-activity summary / suspected-stuck marker) -> aggregate
     into a briefing and PROACTIVELY INJECT it into the secretary session. No
     longer waits for a signal to speak.
  2. COVERAGE LIFECYCLE: a task leaves the coverage list once it has FLAG'd AND
     the historian has reported that completion (reported via the "新信号" line,
     which fires once per new signal). New task books / new loop logs are
     auto-included. Coverage is persisted (state file). Source = watchdog-
     watchdog-manifest.txt is the authoritative focus list. Dynamic discovery
     of loop_*.log is opt-in only (WAKE_DISCOVER_DYNAMIC_LOOPS=1), so completed
     or rejected historical loops do not keep polluting current briefings.
  3. CADENCE: work hours (Beijing 09:00-19:30) -> 4.5 min (270s) per tick; off
     hours -> 20 min (1200s) per tick.
  4. BUSY GATE DOWNGRADED to anti-collision: only avoids the instant the master
     is typing (last real USER message < 60s). No longer stays silent just
     because the conversation is active — the briefing is meant to live in the
     conversation flow. Hourly cap raised to 15.
  5. HARD INSURANCE: any two real injections >= MIN_GAP (270s); <= HOURLY_CAP
     (15) per rolling hour.
  6. LAUNCH FLOW: default DRY-RUN — logs the full briefing + "why skip" to
     waker.log but NEVER calls wake-secretary.py. After 3 dry ticks that
     actually produce a briefing, AUTO-CUT to LIVE (no coordinator gate needed
     this run — V3 behaviour was already verified; the V4 change is only cadence
     + coverage semantics). auto_live is persisted so a crontab respawn stays
     LIVE.

V4.1 adds an akari status line; V4.2 adds a usage line and writes
army_status.json for the lens dashboard every beat. V4.3 (2026-07-16, master:
"零条就别写") adds EMPTY-BOARD SILENCE: when running=0 AND no new signals AND
no stalls, the full briefing is NOT injected (not even "在跑(0条)") — only
logged. At most every SURVIVAL_INTERVAL (2h) a one-line survival confirmation
`[史官] 空板值更中 HH:MM usage: ...` is sent so the master knows the historian
is alive. The survival timer is seeded (not sent) on the first empty-board
beat, and reset on every real briefing, so it only counts QUIET time — a
(re)start never pings immediately. Any signal / new task / stall instantly
breaks the silence and resumes the normal full briefing.

V4.4 (2026-07-16, master: "20 分钟一报 + 区间汇总"):
  1. CADENCE UNIFIED to 20 min: the routine full briefing is gated to
     BRIEF_INTERVAL (1200s) all day (no more work/off split). A fast CHECK
     cadence (CHECK_INTERVAL, default 270s) keeps the waker waking often so
     new SIGNALS / STALLS are still injected IMMEDIATELY ("出事不等 20 分钟") —
     alerts bypass the 20-min gate. Only the routine (no-signal, no-stall)
     briefing waits for the 20-min mark.
  2. INTERVAL SUMMARY: every briefing now leads with a "区间汇总(20min)"
     section aggregating the window since the last briefing — new flags
     (FLAG_/FAILSIG_/SPIN_ listed by kind), completed/new/disappeared tasks,
     and a one-line per-task progress (iter delta + log-increment vs the last
     briefing's task snapshot), replacing the old "只报当前瞬时状态".
  Empty-board silence (V4.3), singleton lock, busy gate, rate limit, hourly
  cap, akari/usage/army_status lines are all unchanged.

V4.4b (2026-07-16 午, master: "连续两拍无差别就别发"):
  DEDUP. After building a briefing, normalize it (strip the [史官简报 HH:MM]
  header, the waker自检 beat-number line, the usage line, and the drifting
  (N分钟前| age in running lines) and compare to the last briefing ACTUALLY
  SENT (persisted as last_brief_norm). If byte-identical -> SKIP dup: do NOT
  inject, only log "SKIP dup", and do NOT consume any snapshot/timer so the
  next beat re-evaluates and the interval diff keeps accumulating. The moment
  any substantive field changes (signals / running set / iter / last_line /
  stalls / ports / akari) the normalized form differs and sending resumes.
  Alerts reach the same path but an alert by definition adds a 新旗/新失败/
  新自旋/停滞告警 line so it is never a dup of the prior briefing. The age
  is normalized away because it is a ticking clock (a task sitting idle grows
  its age every minute), not information — without stripping it the dedup
  would never fire during a frozen period, exactly when the master wants it
  quiet. Survival pings (empty-board one-liner) have their own 2h gate and are
  not deduped.

 史官红线 (historian red line): READ-ONLY, REPORT ONLY, never act — does not
touch FLAG/SPIN/FAILSIG, does not kill or restart any process, does not modify
any file except its own log/state under ~/codex_work/.waker/. Intervention
rights belong entirely to the secretary.

tmux `waker` + crontab self-heal; WAKE_INTERVAL (0 = dynamic cadence) = check
interval.

Usage:
  python3 waker_core.py              # resident loop (DRY-RUN default, auto->LIVE)
  python3 waker_core.py --once       # single beat then exit
  python3 waker_core.py --selftest   # simulated-time demonstration of all V4 gates
  python3 waker_core.py --brief      # print one briefing to stdout, no inject, no log
  python3 waker_core.py --coverage   # print coverage list + running tasks, no inject
  WAKE_LIVE=1 python3 waker_core.py  # force REAL injection (overrides auto-live dry phase)
"""
import os, sys, time, json, glob, subprocess, re, traceback, signal, fcntl, hashlib
from datetime import datetime

HOME       = os.path.expanduser("~")
STATE_DIR  = os.environ.get("WAKE_STATE_DIR", os.path.join(HOME, "codex_work", ".waker"))
LOG        = os.environ.get("WAKE_LOG", os.path.join(HOME, "codex_work", "waker.log"))
SIGNAL_DIR = os.environ.get("WAKE_SIGNAL_DIR", os.path.join(HOME, "codex_work"))
MANIFEST   = os.environ.get("WAKE_MANIFEST", os.path.join(SIGNAL_DIR, "watchdog-manifest.txt"))
DISCOVER_DYNAMIC_LOOPS = os.environ.get("WAKE_DISCOVER_DYNAMIC_LOOPS", "0") == "1"
ARMY_JSON  = os.environ.get("WAKE_ARMY_JSON", os.path.join(HOME, "codex_work", "army_status.json"))
SECRETARY_TEAM    = os.environ.get("SECRETARY_TEAM", "T2")
SECRETARY_SESSION = os.environ.get("SECRETARY_SESSION", "c9c218e4-e310-465e-882a-f4d8a9214da3")
_SEC_CFG   = os.environ.get("SECRETARY_CONFIG_DIR", os.path.join(HOME, ".claude-team2"))
JSONL_DIR  = os.path.join(_SEC_CFG, "projects", "-jfs-home-zhiningjiao")
JSONL_GLOB = SECRETARY_SESSION.split("-")[0] + "-*.jsonl"
WAKE_PY    = os.path.join(HOME, "code", "wake-secretary.py")
# 2026-07-23 codex-term fix: claude tabs gate on the secretary JSONL (busy/
# 在聊); a codex terminal tab has no JSONL, so waker_core must NOT treat an
# empty Claude JSONL as a hard prerequisite for all tabs (that blinded the
# historian after the CODEX handoff). wake-secretary.py branches on the same
# var to pick the terminal-input channel instead of claude-input.
WAKE_TABTYPE = os.environ.get("WAKE_TABTYPE", "claude")  # "claude" | "codex"

LIVE          = os.environ.get("WAKE_LIVE", "0") == "1"
BUSY_SEC      = int(os.environ.get("WAKE_BUSY_SEC", "60"))      # anti-collision: master typing
MIN_GAP       = int(os.environ.get("WAKE_MIN_GAP", "270"))
HOURLY_CAP    = int(os.environ.get("WAKE_HOURLY_CAP", "15"))
STALL_MIN     = int(os.environ.get("WAKE_STALL_MIN", "1500"))  # 25 min
RUN_MAX_AGE   = int(os.environ.get("WAKE_RUN_MAX_AGE", "7200")) # 2 hr — drop abandoned logs
# V4.4 cadence (unified all day): fast CHECK cadence so new signals/stalls are
# caught well under 20 min ("出事不等 20 分钟"), but the ROUTINE full briefing is
# gated to BRIEF_INTERVAL (20 min). Alerts (new signal / stall) bypass the
# 20-min gate and inject immediately.
CHECK_INTERVAL   = int(os.environ.get("WAKE_CHECK_INTERVAL", "270"))   # 4.5 min — wake & sweep
BRIEF_INTERVAL   = int(os.environ.get("WAKE_BRIEF_INTERVAL", "1200"))  # 20 min — routine briefing gate
SURVIVAL_INTERVAL = int(os.environ.get("WAKE_SURVIVAL_INTERVAL", "7200"))  # 2 hr — empty-board survival ping
# V6 节拍制 (主人 2026-07-17): routine 到拍若在聊 → 每 WAKE_RETRY_SEC 复查一次
# (23/26/29min 链式退避)，直到不在聊才发；发出区间覆盖自上次成功简报以来全部。
# WAKE_CONV_SEC = "在聊"判据窗口 (最近 N 秒内有双向消息)；WAKE_STREAMING_SEC =
# jsonl mtime 代理 (秘书 turn 进行中，文件正被追加)。
RETRY_SEC    = int(os.environ.get("WAKE_RETRY_SEC", "180"))     # 3 min — busy/在聊退避重试步长
CONV_SEC     = int(os.environ.get("WAKE_CONV_SEC", "180"))      # 3 min — 在聊判据窗口
STREAMING_SEC = int(os.environ.get("WAKE_STREAMING_SEC", "8"))  # jsonl mtime 流式代理阈值
PORTS         = os.environ.get("WAKE_PORTS", "9475,9476,9480,9481,9482").split(",")
MODE          = "live" if LIVE else "dry"

# 2026-07-18 主人令「史官得再加保护，每次看自己在哪，要汇报给哪」——自锚三件套：
# ①EXPECTED_HOST 主机守卫（防 ai-03 式野史官在错误主机空转 2.5h 无人知）
# ②ANCHOR 写进每拍自检行（主人一眼看到 史官@哪→汇报到哪）
# ③连续注入失败 ntfy 喊人（见 do_inject 调用处 streak 逻辑）
import socket as _socket
EXPECTED_HOST = os.environ.get("SECRETARY_WAKER_HOST", "«INTERNAL_HOST»")
def _self_host():
    try:
        _s = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        _s.connect((EXPECTED_HOST or "«INTERNAL_HOST»", 80))
        ip = _s.getsockname()[0]; _s.close()
        return ip
    except Exception:
        return _socket.gethostname()
SELF_HOST = _self_host()
ANCHOR = (f"史官@{SELF_HOST}→127.0.0.1:{os.environ.get('WAKE_PORT','9475')}"
          f"/tab:{os.environ.get('WAKE_TAB','?')}/sess:{SECRETARY_SESSION[:8]}")
NTFY_URL = os.environ.get("WAKE_NTFY", "http://«INTERNAL_HOST»/zhiningwork")
def ntfy(msg):
    try:
        subprocess.run(["curl", "-s", "-m", "5", "-d", msg, NTFY_URL],
                       timeout=8, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass
BEAT_TIMEOUT  = int(os.environ.get("WAKE_BEAT_TIMEOUT", "90"))  # hard per-beat wall-clock (anti-hang)

SIG_PREFIXES = ("FLAG_", "FAILSIG_", "SPIN_", "BLOCKED_")
SIG_SUFFIX   = "_DONE"
# V4.5 terminal-gap (2026-07-29, mes13819 matrix incident): a REPORT_<tag>.md
# whose first non-empty line is an explicit FAIL/BLOCKED conclusion, while no
# FAILSIG_/BLOCKED_ signal exists, means the worker reported a failure but
# exited 0 without touching a fail signal (exit 0 != success). _SUCCESS_HINT
# excludes success conclusions (PASS/FIXED/OK/...) so a *_PASS report is never
# misread as a fail even if it happened to contain a fail-ish substring.
# NB: \b treats '_' as a word char, so \bFAIL\b would miss MATRIX_FAIL — use
# (?<![A-Za-z]) so SCREAMING_SNAKE_CASE tokens (MATRIX_FAIL, EXPORT_FAIL, …)
# match too.
_FAIL_TOKEN_RE  = re.compile(r'(?<![A-Za-z])(FAIL|BLOCKED)', re.IGNORECASE)
_SUCCESS_HINT_RE = re.compile(r'(?<![A-Za-z])(PASS|FIXED|OK|SUCCESS|DONE|COMPLETE|RESOLVED)',
                              re.IGNORECASE)
_ANSI_RE = re.compile(r'\x1b\[[0-9;]*[A-Za-z]|\x1b[()][AB0]|\x1b[=>]')


# ---------------- logging ----------------

def logmsg(s):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] [{MODE}] {s}"
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")
    print(line, flush=True)


def now_utc():
    return time.time()


def run_cmd(cmd, timeout=10, env=None):
    """subprocess that cannot hang. start_new_session=True makes the child its
    own process-group leader; on timeout we killpg(SIGKILL) the whole group so
    any grandchild holding the stdout pipe dies too — preventing the
    communicate() drain-phase do_select hang. Returns (rc, stdout) or
    (None, "") on failure/timeout."""
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, start_new_session=True, env=env)
    except Exception:
        return None, ""
    try:
        out, err = p.communicate(timeout=timeout)
        # 2026-07-18 排障探针：失败时把 stderr 尾部带回日志（此前 rc=1 时 out 恒空无从诊断）
        if p.returncode and err:
            out = (out or "") + " STDERR:" + err.strip()[-300:]
        return p.returncode, out
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass
        try:
            out, _ = p.communicate(timeout=3)
        except Exception:
            out = ""
        return None, out


# ---------------- dynamic cadence ----------------

# V6: one-shot backoff hint. beat() sets this to RETRY_SEC when a routine-due
# briefing is blocked by 在聊 (or the 60s busy gate while routine is due) so
# the main loop rechecks in 3 min (23/26/29 chain) instead of the default
# CHECK_INTERVAL. Consumed once by sleep_interval() then reverts.
_sleep_hint = [0]


def sleep_interval():
    """V4.4: uniform fast CHECK cadence (default 270s) so new signals/stalls are
    caught well under the 20-min routine interval. WAKE_INTERVAL overrides.
    V6: a backoff hint (set by beat on 在聊/busy-during-due) shortens the next
    sleep to RETRY_SEC (3 min) so the routine recheck forms the 23/26/29 chain."""
    if _sleep_hint[0] > 0:
        s = _sleep_hint[0]
        _sleep_hint[0] = 0
        return s
    env = int(os.environ.get("WAKE_INTERVAL", "0"))
    return env if env > 0 else CHECK_INTERVAL


# ---------------- secretary activity (busy gate, user-only) ----------------

def latest_jsonl():
    files = glob.glob(os.path.join(JSONL_DIR, JSONL_GLOB))
    if not files:
        return None
    return max(files, key=os.path.getmtime)


def _is_tool_result(content):
    if isinstance(content, list):
        for c in content:
            if isinstance(c, dict) and c.get("type") == "tool_result":
                return True
    return False


def last_user_ts(path):
    """Epoch (UTC) of the last REAL user message (type=='user', NOT a tool_result)
    in the jsonl. Returns None if there is no real user message. jsonl timestamps
    are UTC Zulu (e.g. ...Z). V4 busy gate is user-only: only a real human message
    < BUSY_SEC ago counts as 'master is typing right now'."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2); sz = f.tell(); f.seek(max(0, sz - 300000))
            data = f.read().decode("utf-8", "replace")
    except Exception as e:
        logmsg(f"jsonl read error: {e!r}")
        return None
    for line in reversed(data.split("\n")):
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("type") != "user":
            continue
        if _is_tool_result(o.get("message", {}).get("content")):
            continue
        t = o.get("timestamp")
        if not t:
            continue
        try:
            return datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp()
        except Exception:
            continue
    return None


def last_activity_ts(path):
    """V6 在聊判据数据源: epoch (UTC) of the last REAL message in EITHER
    direction (user non-tool-result OR assistant) in the jsonl, folded with
    the file mtime so an in-progress secretary turn (streaming — jsonl being
    appended chunk-by-chunk) counts as 'activity right now'. Returns None if
    no real message and the file is not freshly written. Same jsonl file
    last_user_ts reads (the secretary session log)."""
    last_msg = None
    try:
        with open(path, "rb") as f:
            f.seek(0, 2); sz = f.tell(); f.seek(max(0, sz - 300000))
            data = f.read().decode("utf-8", "replace")
    except Exception:
        return None
    for line in reversed(data.split("\n")):
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        t = o.get("type")
        if t not in ("user", "assistant"):
            continue
        if t == "user" and _is_tool_result(o.get("message", {}).get("content")):
            continue   # tool_result wrapper is not a human/secretary message
        ts = o.get("timestamp")
        if not ts:
            continue
        try:
            last_msg = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        except Exception:
            continue
        break   # most recent real message (either direction)
    # fold in mtime so a streaming turn (file appended < STREAMING_SEC ago)
    # counts as activity at 'now' even before its final message lands.
    try:
        m = os.path.getmtime(path)
    except Exception:
        m = 0.0
    return max(last_msg if last_msg is not None else 0.0, m)


# ---------------- V5 secretary heartbeat death detection (2026-07-30) ----------------
# 3-condition judgment (ALL must be true SIMULTANEOUSLY):
#   (a) >= HB_NO_CONSUME_N (3) consecutive injections with NO jsonl consumption
#       evidence (jsonl did not advance since the previous injection)
#   (b) secretary session jsonl mtime inactive >= HB_STALE_SEC (15 min)
#   (c) a probe injection was sent, >= HB_PROBE_WAIT (90s) waited, and the
#       jsonl STILL did not advance
# Only then -> write SECRETARY_DOWN + lark + ntfy (throttled 30 min).
# Auto-clear when the secretary resumes activity. Claude tabs only (codex has
# no jsonl); LIVE only (dry-run has no real injections -> no consumption to
# measure, would false-positive). READ-ONLY: writes only SECRETARY_DOWN +
# state under STATE_DIR. The concurrent secretary_resurrect worker consumes
# SECRETARY_DOWN — tests must NEVER touch the real ~/codex_work/SECRETARY_DOWN.

def _death_cause(jp):
    """Classify the death cause by grepping the jsonl tail for rate/usage limit
    vs no-response. Returns 'rate.limit' | 'usage.limit' | 'no-response'. The
    jsonl is the secretary's own session log; a rate-limit/usage-limit error
    from the upstream provider lands here as an assistant error message."""
    try:
        with open(jp, "rb") as f:
            f.seek(0, 2); sz = f.tell(); f.seek(max(0, sz - 300000))
            data = f.read().decode("utf-8", "replace")
        if re.search(r'rate[._\-\s]?limit', data, re.IGNORECASE):
            return "rate.limit"
        if re.search(r'usage[._\-\s]?limit', data, re.IGNORECASE):
            return "usage.limit"
    except Exception:
        pass
    return "no-response"


def _lark_send(text):
    """Best-effort lark message to the death-alert chat. Never raises — a lark
    failure must not block the death declaration (ntfy + SECRETARY_DOWN are the
    primary signals; lark is a convenience copy)."""
    try:
        subprocess.run([LARK_CLI, "im", "+messages-send", "--chat-id",
                        DEATH_LARK_CHAT, "--text", text],
                       timeout=15, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
    except Exception:
        pass


def _declare_death(now, jp, streak, stale_sec, cause):
    """Write SECRETARY_DOWN (timestamp + 3-evidence summary + cause), then lark
    + ntfy (throttled HB_ALERT_COOLDOWN=30min). The file is rewritten each call
    so the evidence stays fresh (secretary_resurrect reads it); only the
    lark/ntfy alert is throttled so a long death does not spam every beat."""
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    content = (f"SECRETARY_DOWN\n"
               f"timestamp: {ts}\n"
               f"cause: {cause}\n"
               f"session: {SECRETARY_SESSION}\n"
               f"team: {SECRETARY_TEAM}\n"
               f"anchor: {ANCHOR}\n"
               f"evidence:\n"
               f"  (a) {streak} consecutive injections, no jsonl consumption\n"
               f"  (b) jsonl mtime inactive {stale_sec/60:.0f} min ({jp})\n"
               f"  (c) probe injected, {HB_PROBE_WAIT}s waited, no jsonl activity\n")
    try:
        os.makedirs(os.path.dirname(DEATH_FILE), exist_ok=True)
        with open(DEATH_FILE, "w") as f:
            f.write(content)
    except Exception as e:
        logmsg(f"HEARTBEAT declare_death write error: {e!r}")
    last_alert = float(load_state("hb_last_death_alert", "0") or 0)
    if (now - last_alert) >= HB_ALERT_COOLDOWN:
        msg = (f"‼️ 秘书心跳停止 {ANCHOR}\n"
               f"原因: {cause}\n"
               f"证据: 连续{streak}次注入无消费 + jsonl停滞{stale_sec/60:.0f}min"
               f" + 探针{HB_PROBE_WAIT}s无响应\n"
               f"会话: {SECRETARY_SESSION[:8]} 团队: {SECRETARY_TEAM}\n"
               f"已写 SECRETARY_DOWN，secretary_resurrect 将接手")
        _lark_send(msg)
        ntfy(msg)
        save_state("hb_last_death_alert", str(int(now)))
    logmsg(f"‼️ SECRETARY DOWN declared cause={cause} streak={streak} "
           f"stale={stale_sec/60:.0f}min")


def _clear_death(now):
    """Remove SECRETARY_DOWN (secretary resumed) + ntfy resumed notice. Called
    when the jsonl is freshly active again — the 3-condition death no longer
    holds. Idempotent (no-op if the file is already gone)."""
    try:
        if os.path.exists(DEATH_FILE):
            os.remove(DEATH_FILE)
    except Exception:
        pass
    ntfy(f"✅ 秘书心跳恢复 {ANCHOR} — jsonl 重新活跃，SECRETARY_DOWN 已清除")
    logmsg("HEARTBEAT secretary resumed — SECRETARY_DOWN cleared")


def check_heartbeat(now):
    """3-condition secretary death judgment (claude tabs, LIVE only). Returns
    True when a probe was sent or death was declared this beat -> the caller
    (beat) skips the normal briefing (a dead/being-probed secretary won't
    consume it; the probe/death alert already went out). Returns False to
    proceed with the normal briefing flow.

    The consumption streak is tracked by _hb_track_after_inject (called after
    each successful briefing injection in beat step 5). This function reads the
    persisted streak (condition a) + the live jsonl mtime (condition b), and
    drives the probe -> declare path (condition c). Auto-clear: if
    SECRETARY_DOWN exists and the jsonl is freshly active, remove it."""
    if WAKE_TABTYPE != "claude" or not LIVE:
        return False
    jp = latest_jsonl()
    if not jp:
        return False  # the dormant logic in beat() handles a missing session
    try:
        cur_mtime = os.path.getmtime(jp)
    except Exception:
        return False
    # auto-clear: secretary resumed activity -> remove SECRETARY_DOWN
    if os.path.exists(DEATH_FILE) and (now - cur_mtime) < HB_RESUME_SEC:
        _clear_death(now)
        return False
    streak = int(load_state("hb_no_consume_streak", "0"))
    cond_a = streak >= HB_NO_CONSUME_N
    cond_b = (now - cur_mtime) >= HB_STALE_SEC
    if not (cond_a and cond_b):
        if load_state("hb_probe", "0") != "0":
            save_state("hb_probe", "0")  # conditions no longer met -> clear probe
        return False
    # (a) and (b) both true -> probe path (condition c)
    probe_str = load_state("hb_probe", "0")
    probe_ts = float(probe_str) if probe_str and probe_str != "0" else 0.0
    if probe_ts == 0:
        ok = do_inject("[史官心跳探针] 秘书在吗？请回一声(心跳检测)", urgent=True)
        save_state("hb_probe", str(int(now)))
        save_state("hb_probe_mtime", str(cur_mtime))
        logmsg(f"HEARTBEAT probe sent streak={streak} "
               f"stale={(now-cur_mtime)/60:.0f}min ok={ok} — wait {HB_PROBE_WAIT}s")
        return True
    if (now - probe_ts) < HB_PROBE_WAIT:
        logmsg(f"HEARTBEAT probe {(now-probe_ts):.0f}s ago — waiting {HB_PROBE_WAIT}s")
        return True
    # >= HB_PROBE_WAIT since probe -> did the jsonl advance?
    probe_mtime = float(load_state("hb_probe_mtime", "0") or 0)
    if cur_mtime > probe_mtime + 1:
        # secretary responded to the probe -> alive
        save_state("hb_no_consume_streak", "0")
        save_state("hb_probe", "0")
        logmsg("HEARTBEAT secretary responded to probe — alive, streak reset")
        return True
    # secretary did NOT respond to the probe -> declare death
    cause = _death_cause(jp)
    _declare_death(now, jp, streak, now - cur_mtime, cause)
    return True


def _hb_track_after_inject(now):
    """Called after a successful briefing injection (beat step 5). Records the
    jsonl mtime at injection time and updates the no-consumption streak: if the
    jsonl did NOT advance since the PREVIOUS injection, the streak increments
    (this injection adds to the unconsumed count); if it DID advance, the
    secretary consumed the previous briefing -> streak resets to 0. The streak
    is the input to check_heartbeat's condition (a)."""
    if WAKE_TABTYPE != "claude" or not LIVE:
        return
    jp = latest_jsonl()
    if not jp:
        return
    try:
        cur_mtime = os.path.getmtime(jp)
    except Exception:
        return
    last_inj_mtime = float(load_state("hb_last_inj_mtime", "0") or 0)
    streak = int(load_state("hb_no_consume_streak", "0"))
    if last_inj_mtime > 0 and cur_mtime <= last_inj_mtime + 1:
        streak += 1   # jsonl did not advance since previous injection
    else:
        streak = 0    # consumed (or first injection)
    save_state("hb_no_consume_streak", str(streak))
    save_state("hb_last_inj_mtime", str(cur_mtime))
    save_state("hb_last_inj_ts", str(int(now)))


def decide_routine(now, last_brief, last_msg_ts, interval_event_count,
                   brief_interval=None, conv_sec=None, retry_sec=None):
    """V6 纯节拍决策 (主人 2026-07-17). 输入:
      now                 — 当前 epoch
      last_brief          — 上次成功简报 epoch (区间锚点，由调用方持久化)
      last_msg_ts         — 最近一次双向活动 epoch (last_activity_ts)，None=无活动
      interval_event_count— 自上次简报以来的区间事件数 (new_sigs+new_stalls+
                            running+pending)；0 且无在聊 → 空窗静默
      brief_interval/conv_sec/retry_sec — None 时读模块全局 (调用时解析，方便
                            selftest/env 覆盖；不用默认参数以免绑定到定义时的值)
    输出 (纯函数，无副作用):
      "wait"    — 未到拍 (now-last_brief < brief_interval)
      "backoff" — 到拍但在聊 (最近 conv_sec 内有活动) → 退避 retry_sec 后复查;
                  不前移 last_brief，发出时区间仍覆盖自上次简报
      "silent"  — 到拍、不在聊、但区间无事件 → 空窗静默 (empty-board，由 4a 兜底)；
                  不前移 last_brief (事件不丢)
      "send"    — 到拍、不在聊、区间有事件 → 立即发，覆盖 [last_brief, now]
    P0/interrupt alert 路径完全绕过本函数 (顶部 busy 门 interrupt override +
    alert 路径直接发)。retry_sec 是退避步长 (调用方据此睡 retry_sec 后复查，
    形成 23/26/29 链)，本函数只裁定是否退避。"""
    if brief_interval is None:
        brief_interval = BRIEF_INTERVAL
    if conv_sec is None:
        conv_sec = CONV_SEC
    # retry_sec is consumed by the caller (sleep hint); kept in the signature
    # so the cadence chain is unit-testable end-to-end.
    if last_brief is None:
        last_brief = 0.0
    if (now - last_brief) < brief_interval:
        return "wait"
    conversing = last_msg_ts is not None and (now - last_msg_ts) < conv_sec
    if conversing:
        return "backoff"
    if interval_event_count <= 0:
        return "silent"
    return "send"# ---------------- signals ----------------

def scan_signals():
    names = set()
    try:
        for fn in os.listdir(SIGNAL_DIR):
            p = os.path.join(SIGNAL_DIR, fn)
            if not os.path.isfile(p):
                continue
            if fn.startswith(SIG_PREFIXES) or fn.endswith(SIG_SUFFIX):
                names.add(fn)
    except Exception as e:
        logmsg(f"scan_signals error: {e!r}")
    return names


def load_p0_tags():
    """P0 tags (one per line, # comments ok) from ~/codex_work/P0_TAGS.
    A P0 tag's FLAG_/FAILSIG_/BLOCKED_ landing = decision-needed -> interrupt."""
    path = os.path.join(SIGNAL_DIR, "P0_TAGS")
    tags = set()
    try:
        with open(path) as f:
            for ln in f:
                ln = ln.strip()
                if ln and not ln.startswith("#"):
                    tags.add(ln)
    except Exception:
        pass
    return tags


def interrupt_reasons(new_sigs, usage_alarm, term_gap=None):
    """闯宫禀报分类（主人 2026-07-17）：① P0 事项进展需决策（P0 tag 的
    FLAG/FAILSIG/BLOCKED 落地）② 熔断/block（SPIN_* / BLOCKED_*）③ 用量告警。
    V4.5 (2026-07-29): ④ 终态信号消失（task vanished with no terminal signal）。
    命中即绕过 busy 门 / rate-limit / hourly-cap，sendNow 强插对话。"""
    reasons = []
    p0 = load_p0_tags()
    for sig in sorted(new_sigs):
        if sig.startswith("SPIN_"):
            reasons.append(f"熔断空转 {sig}")
        elif sig.startswith("BLOCKED_"):
            reasons.append(f"任务被阻塞 {sig}")
        else:
            for t in p0:
                if sig in (f"FLAG_{t}", f"FAILSIG_{t}"):
                    reasons.append(f"P0[{t}] 有进展需决策 ({sig})")
    if term_gap:
        reasons.append("无终态信号消失 " + ",".join(sorted(term_gap)))
    if usage_alarm:
        reasons.append("用量达搬家阈值")
    return reasons


def fmt_signal_list(sigs):
    sigs = sorted(sigs)
    if len(sigs) > 20:
        return ", ".join(sigs[:20]) + f" (+{len(sigs)-20} more)"
    return ", ".join(sigs)


# ---------------- state ----------------

def _state_file(key):
    return os.path.join(STATE_DIR, key)


def load_state(key, default):
    try:
        with open(_state_file(key)) as f:
            return f.read().strip()
    except Exception:
        return default


def save_state(key, val):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(_state_file(key), "w") as f:
        f.write(str(val))


def load_snapshot():
    try:
        with open(_state_file("snapshot")) as f:
            return set(json.load(f))
    except Exception:
        return None  # None => not yet baselined


def save_snapshot(s):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(_state_file("snapshot"), "w") as f:
        json.dump(sorted(s), f)


def load_stall_snapshot():
    try:
        with open(_state_file("stall_snapshot")) as f:
            return set(json.load(f))
    except Exception:
        return None


def save_stall_snapshot(s):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(_state_file("stall_snapshot"), "w") as f:
        json.dump(sorted(s), f)


def load_task_snapshot():
    """V4.4 interval-summary baseline: {tag: {iter, last}} of every running
    task at the time of the last briefing. None => not yet baselined."""
    try:
        with open(_state_file("task_snapshot")) as f:
            return json.load(f)
    except Exception:
        return None


def save_task_snapshot(d):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(_state_file("task_snapshot"), "w") as f:
        json.dump(d, f)


def load_coverage():
    try:
        with open(_state_file("coverage")) as f:
            return set(json.load(f))
    except Exception:
        return set()


def save_coverage(c):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(_state_file("coverage"), "w") as f:
        json.dump(sorted(c), f)


def load_pending_state():
    """V4.4 待批复 per-tag beat counter. {tag: {"beats": N, "line": "..."}}.
    'beats' counts consecutive SENT briefings in which the tag's pending marker
    was still present; it resets to 0 (auto-remove) the moment the marker
    disappears (master: 绝不允许再出现 29 轮长草)."""
    try:
        with open(_state_file("pending_state")) as f:
            return json.load(f)
    except Exception:
        return {}


def save_pending_state(d):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(_state_file("pending_state"), "w") as f:
        json.dump(d, f, ensure_ascii=False)


def load_stats():
    try:
        with open(_state_file("stats")) as f:
            return json.load(f)
    except Exception:
        return {"beat": 0, "skip": {}}


def save_stats(s):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(_state_file("stats"), "w") as f:
        json.dump(s, f)


def inc_stat(key):
    s = load_stats()
    if key == "beat":
        s["beat"] = s.get("beat", 0) + 1
    else:
        sk = s.setdefault("skip", {})
        sk[key] = sk.get(key, 0) + 1
    save_stats(s)


def inject_count_hour():
    p = _state_file(f"inject_{MODE}.log")
    now = now_utc(); c = 0
    try:
        with open(p) as f:
            for line in f:
                try:
                    e = float(line.strip().split()[0])
                    if now - e < 3600:
                        c += 1
                except Exception:
                    pass
    except Exception:
        pass
    return c


def append_inject():
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(_state_file(f"inject_{MODE}.log"), "a") as f:
        f.write(f"{now_utc():.0f}\n")


# ---------------- briefing data sources (read-only) ----------------

def strip_ansi(s):
    s = _ANSI_RE.sub("", s)
    s = re.sub(r'[\x00-\x1f\x7f]', '', s)
    return s.strip()


def read_manifest_tags():
    """Deduped TAG list from watchdog-manifest.txt (TAG|WD[|MODEL])."""
    tags = []
    seen = set()
    try:
        with open(MANIFEST) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                tag = line.split("|")[0].strip()
                if not tag or tag in seen:
                    continue
                seen.add(tag)
                tags.append(tag)
    except Exception:
        pass
    return tags


def discover_tags():
    """Coverage universe = the explicit watchdog manifest focus list.

    Dynamic loop_*.log discovery is retained only as an opt-in compatibility
    mode. Signals are scanned independently, so disabling dynamic loop
    discovery does not hide new FLAG_/FAILSIG_/SPIN_/BLOCKED_ alerts.
    """
    tags = list(read_manifest_tags())
    if not DISCOVER_DYNAMIC_LOOPS:
        return tags
    seen = set(tags)
    for f in glob.glob(os.path.join(SIGNAL_DIR, "loop_*.log")):
        tag = os.path.basename(f)[5:-4]  # loop_TAG.log -> TAG
        if tag and tag not in seen:
            seen.add(tag)
            tags.append(tag)
    return tags


def parse_runner_iter(tag, data):
    """V4.5 iter-boundary fix (2026-07-29): extract the current runner iter
    number ONLY from the runner's own anchor lines.

    The runner (run_team2_observable.sh) writes exactly two anchor shapes per
    round, both beginning `=== <tag> iter N`:
        `=== <tag> iter N <date> ===`            (round start)
        `=== <tag> iter N end exit=R dur=Ks ...`   (round end)
    The loop_<tag>.log tail may ALSO contain arbitrary worker stdout — the body
    of OLD log files the worker is `cat`-ing, a REPORT, or command output
    that legitimately mentions `iter 6`. The previous
    `re.findall(r'iter (\\d+)', data)` + `max()` swallowed those as the current
    runner round, misreporting e.g. a worker on iter 1 that happened to Read an
    old `iter 6` log as "iter 6". Restricting the match to the tag-anchored
    line prefix eliminates that. Returns the int iter, or None when no anchor
    is present yet (fresh log with only the LOOP start header)."""
    nums = [int(m) for m in re.findall(
        r'=== ' + re.escape(tag) + r' iter (\d+)', data)]
    return max(nums) if nums else None


def task_info_v4(tag):
    """Return a running-task dict or None. READ-ONLY.
    None when: FLAG exists (done), no loop log (not started/vanished),
    or loop log older than RUN_MAX_AGE (abandoned)."""
    if os.path.exists(os.path.join(SIGNAL_DIR, f"FLAG_{tag}")):
        return None  # done
    log = os.path.join(SIGNAL_DIR, f"loop_{tag}.log")
    if not os.path.exists(log):
        return None
    age = now_utc() - os.path.getmtime(log)
    if age > RUN_MAX_AGE:
        return None  # abandoned (no FLAG, no update for >2h)
    spin = os.path.exists(os.path.join(SIGNAL_DIR, f"SPIN_{tag}"))
    iterno = None
    last_line = ""
    try:
        with open(log, "rb") as f:
            f.seek(0, 2); sz = f.tell(); f.seek(max(0, sz - 65536))
            data = f.read().decode("utf-8", "replace")
        iterno = parse_runner_iter(tag, data)
        for ln in reversed(re.split(r'[\n\r]', data)):
            ln = strip_ansi(ln)
            if ln:
                last_line = ln
                break
    except Exception as e:
        last_line = f"<read err {e!r}>"
    return {"tag": tag, "age": age, "iter": iterno,
            "last": last_line[:60], "spin": spin,
            "workdir": manifest_workdir(tag)}


def running_tasks():
    """Every focused running task (manifest tag, loop log, no FLAG, <2h old)."""
    out = []
    for tag in discover_tags():
        ti = task_info_v4(tag)
        if ti:
            out.append(ti)
    return out


def terminal_signal_exists(tag):
    """True iff ANY terminal signal file for tag exists (FLAG/FAILSIG/SPIN/
    BLOCKED). A task with a terminal signal left the running set legitimately
    (success or a known/already-alerted failure) -> not a gap."""
    for pref in SIG_PREFIXES:
        if os.path.exists(os.path.join(SIGNAL_DIR, f"{pref}{tag}")):
            return True
    return False


def detect_terminal_gap(snap, running):
    """V4.5 terminal-signal gap (2026-07-29, mes13819 matrix incident).

    Returns the set of tags that were running at the last SENT briefing
    (task_snap baseline) but are gone from the current running set AND have
    NO terminal signal (FLAG/FAILSIG/SPIN/BLOCKED). This is the failure mode
    the historian silently swallowed: the worker writes a FAIL report, exits
    0, touches no signal, the process dies -> the loop log stops / the
    manifest line is pulled -> the task drops out of running_tasks() -> with
    running=0 and no new signal the board fell into empty-board silence for
    hours. Detecting the gap here turns it into a prominent ALERT that breaks
    empty-board silence and bypasses the 20-min routine gate, exactly like a
    new FAILSIG. Read-only."""
    snap_tags = set((snap or {}).keys())
    cur_tags = {t["tag"] for t in running}
    gone = snap_tags - cur_tags
    return {tag for tag in gone if not terminal_signal_exists(tag)}


def report_fail_firstline(tag):
    """V4.5 requirement 2 (2026-07-29): if REPORT_<tag>.md exists and its
    first non-empty line is an explicit FAIL/BLOCKED conclusion while no
    FAILSIG_<tag>/BLOCKED_<tag> signal exists, return that first line. This is
    the 'report explicitly says FAIL but worker exited 0 with no fail signal'
    case (exit 0 != success). Read-only; returns None otherwise (no report,
    report not a fail conclusion, or a fail signal already present)."""
    for pref in ("FAILSIG_", "BLOCKED_"):
        if os.path.exists(os.path.join(SIGNAL_DIR, f"{pref}{tag}")):
            return None  # terminal-fail signal already present -> not our case
    path = os.path.join(SIGNAL_DIR, f"REPORT_{tag}.md")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r") as f:
            for ln in f:
                ln = ln.strip()
                if not ln:
                    continue
                head = ln.lstrip("#").strip()
                if head and _FAIL_TOKEN_RE.search(head) and not _SUCCESS_HINT_RE.search(head):
                    return head
                return None  # first non-empty line is not a fail conclusion
    except Exception:
        return None
    return None


def stalled_set(running):
    return {t["tag"] for t in running if t["age"] > STALL_MIN}


def write_army_status(running):
    """Write the external-army status JSON (atomic tmp+mv) for the lens
    dashboard's External Army panel. READ-ONLY reporting — does not touch
    FLAG/SPIN/FAILSIG or any task file; writes only army_status.json under
    ~/codex_work/. Schema: [{tag, iter, last_active_s, last_line, stalled, flag}].
    `last_active_s` = seconds since the loop log was last modified (the task's
    `age`); `flag` = whether SPIN_<tag> exists (a manual spin marker)."""
    entries = []
    for t in running:
        entries.append({
            "tag": t["tag"],
            "iter": t["iter"],
            "last_active_s": round(t["age"]),
            "last_line": t["last"],
            "stalled": t["age"] > STALL_MIN,
            "flag": t["spin"],
        })
    tmp = ARMY_JSON + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(entries, f)
        os.replace(tmp, ARMY_JSON)
    except Exception as e:
        logmsg(f"write_army_status error: {e!r}")


def tmux_brief():
    res = []
    ls_rc, ls_out = run_cmd(["tmux", "ls"], timeout=5)
    if ls_rc is None or ls_rc != 0:
        return res
    for line in ls_out.splitlines():
        name = line.split(":")[0].strip()
        if not name:
            continue
        last = ""
        cp_rc, cp_out = run_cmd(["tmux", "capture-pane", "-t", name, "-p",
                                 "-S", "-"], timeout=5)
        for ln in reversed(re.split(r'[\n\r]', cp_out)):
            ln = strip_ansi(ln)
            if ln:
                last = ln
                break
        res.append(f"{name}({last[:40]})")
    return res


def port_brief():
    parts = []
    for p in PORTS:
        ok = False
        code_rc, code_out = run_cmd(
            ["curl", "-s", "-o", "/dev/null", "-m", "3", "-w", "%{http_code}",
             f"http://127.0.0.1:{p}/"],
            timeout=6)
        ok = code_out.strip() not in ("", "000")
        parts.append(f"{p}{'✓' if ok else '✗'}")
    return " ".join(parts)


AKARI_PORT   = int(os.environ.get("WAKE_AKARI_PORT", "9481"))
AKARI_LENS   = os.environ.get("WAKE_AKARI_LENS", "http://«INTERNAL_HOST»:9482")
AKARI_LANES_MAX = int(os.environ.get("WAKE_AKARI_LANES_MAX", "16"))
# 2026-07-31 史官纳管 akari：fleet run manifest 根（recent_terminals 的 failure 字段只
# 带第一条 terminal_reason；要给「log 尾摘要」就直读 <root>/<run_id>/manifest.json 取
# 全量 terminal_reasons）。best-effort：路径不存在/读失败一律回退到 API 的 failure 字段，
# 绝不因猜路径崩史官。env 可覆盖（部署换 repo 时）。
AKARI_RUNS_ROOT = os.environ.get(
    "WAKE_AKARI_RUNS_ROOT",
    # QA P2-2 修：真实 manifest 在 lanes/akari-server/fleets/<run_id>/manifest.json（QA 实测），
    # 旧默认 .akari/runs 不存在 → 默认部署下 log 尾摘要静默降级成 API 截断首条
    os.path.join(HOME, "code", "akari", ".akari", "lanes", "akari-server", "fleets"))

USAGE_LOG      = os.environ.get("WAKE_USAGE_LOG", os.path.join(HOME, "codex_work", "usage_snap.log"))
USAGE_STALE_MIN = int(os.environ.get("WAKE_USAGE_STALE_MIN", "2400"))  # 40 min

# V5 (2026-07-30) lightweight per-task diff snapshot + secretary heartbeat death.
# Diff layer per design doc REPORT_historian_diff_review_merge_design.md:
# LIGHTWEIGHT only (fingerprint + changed-file/diff-stat + new-commit summary,
# <=5/tree). LLM critic subprocess + decide_critic spawn/defer/pending +
# quiet-hours gate + PACE speed judgment are NOT this phase (deferred).
CRITIC_DIR      = os.environ.get("WAKE_CRITIC_DIR", os.path.join(HOME, "codex_work", ".critic"))
DIFF_BUDGET     = int(os.environ.get("WAKE_DIFF_BUDGET", "60"))      # per-beat diff wall-clock (s)
DIFF_MAX_CHANGED = int(os.environ.get("WAKE_DIFF_MAX_CHANGED", "256"))  # fingerprint file cap
DIFF_MAX_COMMITS = int(os.environ.get("WAKE_DIFF_MAX_COMMITS", "5"))    # new-commit summary cap
# Heartbeat death: 3-condition judgment (ALL must be true simultaneously):
#   (a) >= HB_NO_CONSUME_N consecutive injections with no jsonl consumption
#   (b) jsonl mtime inactive >= HB_STALE_SEC
#   (c) probe injected, HB_PROBE_WAIT waited, still no jsonl activity
DEATH_FILE       = os.environ.get("WAKE_DEATH_FILE", os.path.join(HOME, "codex_work", "SECRETARY_DOWN"))
DEATH_LARK_CHAT  = os.environ.get("WAKE_DEATH_LARK_CHAT", "«FEISHU_CHAT_ID»")
LARK_CLI         = os.environ.get("WAKE_LARK_CLI", os.path.join(HOME, ".local", "lib", "npm-global", "bin", "lark-cli"))
HB_NO_CONSUME_N   = int(os.environ.get("WAKE_HB_NO_CONSUME", "3"))    # condition (a)
HB_STALE_SEC      = int(os.environ.get("WAKE_HB_STALE_SEC", "900"))  # condition (b): 15 min
HB_PROBE_WAIT     = int(os.environ.get("WAKE_HB_PROBE_WAIT", "90"))  # condition (c): 90s
HB_ALERT_COOLDOWN = int(os.environ.get("WAKE_HB_ALERT_COOLDOWN", "1800"))  # 30 min between alerts
HB_RESUME_SEC     = int(os.environ.get("WAKE_HB_RESUME_SEC", "300"))  # active <5min = resumed

# V4.4 待批复 (pending-approval) scan. READ-ONLY: scans the last PENDING_SCAN_LINES
# lines of loop_*.log / REPORT_*.md (files < PENDING_MAX_AGE old) plus the
# explicit PENDING_APPROVALS.md registry for marker words indicating a decision
# is waiting on the coordinator/master. One entry per tag; a per-tag counter
# persists across beats ("等了N拍") and ‼️-escalates at >=2 consecutive beats so
# a lingering request can never silently rot (master: 绝不允许再出现 29 轮长草).
#
# Marker tiers (master: "curated for REPORTs, strict for loop logs"):
#   _PENDING_STRICT — action-oriented blocked markers ONLY (等批复/球在协调方/
#                     待主人/请批复/awaiting approval). Used for raw loop_*.log,
#                     which is noisy dev output where the generic 待批复 /
#                     'pending approval' / 'sign-off' appear incidentally (in
#                     code, diffs, this very feature's name & function
#                     scan_pending_approvals). Word boundary on `approval\b` so
#                     the function name 'scan_pending_approvals' cannot match.
#   _PENDING_STRONG — STRICT + the curated extras (待审核/待批复/pending approval/
#                     sign-off-pending). Used for REPORT_*.md + the registry,
#                     which are curated, trustworthy documents.
#   _PENDING_SIGNOFF— bare 'sign-off', allowed ONLY for REPORTs + the registry
#                     (with done-word negation so 'sign-off passed' is skipped).
#   _PENDING_NOISE  — self-referential / code artifacts the historian must never
#                     report as a pending approval: git-diff additions ('+…'),
#                     the waker's own log lines ('[YYYY-MM-DD HH:MM:SS] [live]'),
#                     its own briefing format ('待批复(N条):', '… 等了N拍 —'),
#                     and todo checkboxes ('[✓]…' / '- [ ]…'). Applied to all
#                     sources. A genuine worker status line matches none of these.
PENDING_FILE      = os.environ.get("WAKE_PENDING_FILE", os.path.join(SIGNAL_DIR, "PENDING_APPROVALS.md"))
PENDING_MAX_AGE   = int(os.environ.get("WAKE_PENDING_MAX_AGE", "259200"))   # 3 days
PENDING_SCAN_LINES= int(os.environ.get("WAKE_PENDING_SCAN_LINES", "200"))
PENDING_SCAN_BYTES= int(os.environ.get("WAKE_PENDING_SCAN_BYTES", "65536"))
PENDING_MAX_LINE  = int(os.environ.get("WAKE_PENDING_MAX_LINE", "120"))
_PENDING_STRICT = re.compile(
    r'等批复|等协调方|球在协调方|待主人|请批复|awaiting[\s_-]?approval\b',
    re.IGNORECASE)
_PENDING_STRONG = re.compile(
    r'等批复|等协调方|球在协调方|待审核|待主人|待批复|请批复'
    r'|awaiting[\s_-]?approval\b|pending[\s_-]?approval\b'
    r'|pending[\s_-]{0,3}sign-?off|sign-?off[\s_-]{0,3}pending',
    re.IGNORECASE)
_PENDING_SIGNOFF = re.compile(r'sign-?off', re.IGNORECASE)
_PENDING_DONE    = re.compile(r'已批|已审|已通过|已验收|approved\b|\bpassed\b|\bdone\b|✅', re.IGNORECASE)
_PENDING_SPEC    = re.compile(r'TASK wake_reliability|外部唤醒器|唤醒器：tmux')
_PENDING_NOISE   = re.compile(
    r'^\+'                                            # git-diff addition line
    r'|^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[(?:live|dry)\]'  # waker's own log line
    r'|^待批复\(\d+条\)'                               # waker's own briefing header
    r'|等了\d+拍\b'                                    # waker's own per-tag briefing line
    r'|^\[[✓xX ]\]'                                   # checkbox todo  '[✓] …'
    r'|^-\s\[[✓xX ]\]',                               # checkbox todo  '- [ ] …'
    re.IGNORECASE)


def _read_tail(path, max_lines, max_bytes):
    """Return the last max_lines non-empty lines (ansi-stripped) of path, reading
    at most max_bytes from the tail. Bounded so a multi-MB log stays cheap."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2); sz = f.tell(); f.seek(max(0, sz - max_bytes))
            data = f.read().decode("utf-8", "replace")
    except Exception:
        return []
    lines = [strip_ansi(ln).strip() for ln in re.split(r'[\r\n]', data) if ln.strip()]
    return lines[-max_lines:]


def _pending_match(line, marker_re, allow_signoff):
    """True if line carries a pending-approval marker AND survives the noise
    filters. READ-ONLY, zero-LLM, deterministic.
      length gate  — skip lines > PENDING_MAX_LINE (the 11k-char task spec,
                     code blocks, stack traces that merely quote a marker)
      noise gate   — skip self-referential / code artifacts (git diffs, the
                     waker's own log & briefing format, todo checkboxes) that
                     can never be a real worker status line
      spec gate    — skip the waker's OWN task book (it contains 待主人圣旨 etc.)
      done gate    — skip lines that also carry a done-word (已批/已通过/passed/
                     ✅ …) so 'sign-off passed' / '已批复' never false-fire
      marker       — marker_re (STRICT for loop logs, STRONG for REPORTs) is
                     always sufficient
      sign-off     — bare 'sign-off' ONLY when allow_signoff (REPORTs + the
                     explicit registry); too noisy in raw loop logs where it
                     appears in code comments / passing-test banners"""
    if len(line) > PENDING_MAX_LINE:
        return False
    if _PENDING_NOISE.search(line):
        return False
    if _PENDING_SPEC.search(line):
        return False
    if _PENDING_DONE.search(line):
        return False
    if marker_re.search(line):
        return True
    if allow_signoff and _PENDING_SIGNOFF.search(line):
        return True
    return False


def scan_pending_approvals():
    """V4.4 待批复 — READ-ONLY scan for decisions waiting on the coordinator /
    master. Returns {tag: one_line_decision_point}. One entry per tag (last
    matching line wins). Sources, all younger than PENDING_MAX_AGE (3 days):
      loop_*.log   — STRICT markers only (raw logs are noisy dev output; the
                     generic 待批复 / 'pending approval' / bare sign-off appear
                     incidentally in code, diffs & this feature's own name)
      REPORT_*.md  — STRONG markers OR bare sign-off (curated reports are
                     trustworthy documents)
      PENDING_APPROVALS.md — explicit registry workers may write; section (`## x`)
                     under which a marker line sits becomes its tag, falling
                     back to 'PENDING_APPROVALS'. Same STRONG set as REPORTs.
    All sources pass the _PENDING_NOISE gate (git diffs / the waker's own log &
    briefing format / todo checkboxes are never a real pending approval). A task
    whose FLAG_<tag> exists is DONE and is never reported from loop_*.log or
    REPORT_*.md — a finished task's logs may still hold historical markers, but
    it is not awaiting any decision. The explicit PENDING_APPROVALS.md registry
    is exempt (it is a deliberate signal and its section names need not match a
    FLAG filename)."""
    out = {}
    cutoff = now_utc() - PENDING_MAX_AGE
    done = {os.path.basename(f)[5:] for f in glob.glob(os.path.join(SIGNAL_DIR, "FLAG_*"))}
    for f in glob.glob(os.path.join(SIGNAL_DIR, "loop_*.log")):
        try:
            if os.path.getmtime(f) < cutoff:
                continue
        except OSError:
            continue
        tag = os.path.basename(f)[5:-4]
        if tag in done:
            continue
        for ln in _read_tail(f, PENDING_SCAN_LINES, PENDING_SCAN_BYTES):
            if _pending_match(ln, _PENDING_STRICT, allow_signoff=False):
                out[tag] = ln[:80]
    for f in glob.glob(os.path.join(SIGNAL_DIR, "REPORT_*.md")):
        try:
            if os.path.getmtime(f) < cutoff:
                continue
        except OSError:
            continue
        tag = os.path.basename(f)[7:-3]
        if tag in done:
            continue
        for ln in _read_tail(f, PENDING_SCAN_LINES, PENDING_SCAN_BYTES):
            if _pending_match(ln, _PENDING_STRONG, allow_signoff=True):
                out[tag] = ln[:80]
    if os.path.exists(PENDING_FILE):
        section = "PENDING_APPROVALS"
        for ln in _read_tail(PENDING_FILE, PENDING_SCAN_LINES, PENDING_SCAN_BYTES):
            m = re.match(r'^#{1,6}\s+(.+?)\s*$', ln)
            if m:
                section = m.group(1).strip()
                continue
            if _pending_match(ln, _PENDING_STRONG, allow_signoff=True):
                out[section] = ln[:80]
    return out


def akari_brief():
    """One-line akari status: `akari: running=N peak=N lanes=N/16` plus the
    lens dashboard link ONLY when running>0 or lanes>0 (idle = no link, saves
    visual noise). READ-ONLY — two GETs with 3s timeout, fault-tolerant."""
    rc_cc, out_cc = run_cmd(
        ["curl", "-s", "-m", "3", f"http://127.0.0.1:{AKARI_PORT}/api/concurrency"],
        timeout=6)
    running = peak = lanes = 0
    if rc_cc == 0 and out_cc:
        try:
            d = json.loads(out_cc)
            running = int(d.get("running", 0))
            peak = int(d.get("peak", 0))
            lanes = int(d.get("open_lanes", 0))
        except Exception:
            pass
    base = f"akari: running={running} peak={peak} lanes={lanes}/{AKARI_LANES_MAX}"
    if running > 0 or lanes > 0:
        return f"{base} ▸ {AKARI_LENS}"
    return base


# ---------------- akari job-level watch (2026-07-31 史官纳管) ----------------
# akari_brief() 仍是空闲时唯一一行（一字不动）。akari 有活时这里逐 job 展开：
# 终态(成功/失败)置于区间汇总同级视野、失败附 log 尾摘要、busy lane 给 diff 快照。
# 全程只读 GET（curl -m 3 风格），akari 挂了 → 返回 "" 兜住，史官绝不跟着崩。
# 块内字段无漂移（终态 completed_at 固定、running 用起始HH:MM 而非 elapsed、progress 仅
# 真变化才变）→ 未变即字节同一 → 复用既有 dedup，无需新增 normalize 正则。

def _akari_get(path, timeout=6):
    """READ-ONLY GET to akari server with 3s curl cap. Returns parsed JSON or
    None on any failure (akari down / non-200 / bad JSON). The waker never
    crashes on akari — same fault posture as akari_brief's concurrency GET."""
    rc, out = run_cmd(["curl", "-s", "-m", "3",
                       f"http://127.0.0.1:{AKARI_PORT}{path}"], timeout=timeout)
    if rc != 0 or not out:
        return None
    try:
        return json.loads(out)
    except Exception:
        return None


def _akari_term_log_tail(run_id, api_failure):
    """Best-effort log tail for a terminal fleet run. recent_terminals only
    carries the FIRST terminal_reason; for a real 「log 尾摘要」read the run
    manifest's full terminal_reasons. Degrades to the API failure field when
    the manifest is absent/unreadable (akari repo moved / run pruned) — never
    raises. Returns a single-line summary string."""
    root = AKARI_RUNS_ROOT
    if run_id and root:
        try:
            with open(os.path.join(root, run_id, "manifest.json")) as f:
                m = json.load(f)
            tr = m.get("terminal_reasons")
            reasons = []
            if isinstance(tr, list):
                reasons = [str(x) for x in tr if x]
            elif isinstance(tr, dict):
                reasons = [str(v) for v in tr.values() if v]
            if reasons:
                return "；".join(reasons[:3])
        except Exception:
            pass
    return (api_failure or "") if api_failure else ""


def _safe_float(x, default=0.0):
    """akari 契约字段防御：类型错（str/list/dict）一律回退 default，绝不让排序键炸主循环（QA P2-1）。"""
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def _akari_start_hhmm(elapsed_secs, now_ts):
    """Worker start wall-clock as HH:MM = now - elapsed. Stable across beats
    (both now and elapsed advance by the real interval, so start is fixed) ->
    drift-free for dedup. '' when elapsed missing."""
    try:
        e = float(elapsed_secs)
    except (TypeError, ValueError):
        return ""
    if e < 0:
        return ""
    return time.strftime("%H:%M", time.localtime(now_ts - e))


def _akari_progress(w):
    """One-line recent progress for a running worker: prefer last_reasoning,
    then current_activity, then last_tool. Truncated. '' when none."""
    for key in ("last_reasoning", "current_activity", "last_tool"):
        v = (w or {}).get(key)
        if v:
            v = str(v).strip().replace("\n", " ")
            return v[:60] + ("…" if len(v) > 60 else "")
    return ""


def akari_jobs_lines(lens, workers, asks, lanes, now_ts):
    """No-HTTP projection (does read-only git for lane diffs) of parsed akari JSON -> briefing block
    lines. Returns a list of lines (empty list = idle = no noise).

    lens   = parsed /api/lens/lanes  -> {lanes:[{id,state,occupant,head_short,run}],
                                          recent_terminals:[{name,outcome,failure,
                                                             completed_at,run_id}]}
    workers= parsed /api/workers     -> {workers:[WorkerStatus], ...}
    asks   = parsed /api/asks        -> {asks:[{ask_id,question,age_secs}]}
    lanes  = parsed /api/lanes       -> {lanes:[{id,checkout_path,at_main,
                                                 head_short,occupant,...}]}
    now_ts = now_utc() snapshot for start-time math.

    Terminal states are placed FIRST (新旗/完成 同级视野 — failures must not
    silently vanish, CW §9). Running jobs + pending asks follow. Lane diff
    snapshots (reuse the tmux fp/新提交 style) are appended for busy lanes that
    have diverged from main or have working-tree changes."""
    if not lens:
        return []
    L = []

    # --- terminal states (high visibility, drift-free) ---
    terms = (lens.get("recent_terminals") or [])[:5]
    terms = [t for t in terms if isinstance(t, dict)]
    if terms:
        L.append(f"akari终态({len(terms)}):")
        for t in terms:
            name = str(t.get("name") or t.get("run_id") or "?")
            outcome = str(t.get("outcome") or "")
            comp = str(t.get("completed_at") or "")
            comp_short = comp[11:16] if len(comp) >= 16 else comp  # HH:MM of ISO
            if outcome == "failed":
                tail = _akari_term_log_tail(t.get("run_id"), t.get("failure"))
                tail_part = f" 「{tail}」" if tail else ""
                L.append(f"  ‼️ {name}: 失败{tail_part} @{comp_short}")
            elif outcome == "merged":
                L.append(f"  {name}: 成功(merged) @{comp_short}")
            else:
                L.append(f"  {name}: {outcome or '?'} @{comp_short}")

    # --- running jobs (per-worker tag/state/start/progress) ---
    wlist = [w for w in (workers.get("workers") or []) if isinstance(w, dict)]
    # live = non-terminal (queued/running/waiting); terminal rows are transient
    # retention and belong to the terminal band above, not the running section.
    live = [w for w in wlist
            if str(w.get("state", "")) in ("queued", "running", "waiting")]
    if live:
        L.append(f"akari在跑({len(live)}):")
        # root workers (no parent) first, then forks; newest-elapsed last for stability
        live.sort(key=lambda w: (bool(w.get("parent_worker_id")),
                                 -_safe_float(w.get("elapsed_secs"))))  # QA P2-1：类型错的 elapsed_secs 不许炸简报
        for w in live[:8]:
            label = str(w.get("label") or w.get("worker_id") or "?")
            state = str(w.get("state") or "?")
            st = _akari_start_hhmm(w.get("elapsed_secs"), now_ts)
            st_part = f"|{st}" if st else ""
            prog = _akari_progress(w)
            prog_part = f"|{prog}" if prog else ""
            att = w.get("needs_attention")
            att_part = " ⚠" + str(att) if att else ""
            turn = w.get("turn")
            turn_part = f"|t{turn}" if isinstance(turn, int) and turn else ""
            L.append(f"  {label}({state}{st_part}{turn_part}{prog_part}){att_part}")

    # --- pending asks (worker needs human input — 待批复 同类) ---
    alist = [a for a in (asks.get("asks") or []) if isinstance(a, dict)]
    if alist:
        L.append(f"akari待批复({len(alist)}):")
        for a in alist[:5]:
            q = str(a.get("question") or "").strip().replace("\n", " ")
            q = q[:50] + ("…" if len(q) > 50 else "")
            L.append(f"  {a.get('ask_id', '?')}: {q}")

    # --- lane diff snapshots (reuse tmux fp/新提交 style) ---
    # Only busy lanes (a live run) that carry real work (diverged from main OR
    # working-tree changes) get a diff line — idle/stale lanes are noise.
    lens_lanes = lens.get("lanes") or []
    busy_ids = {str(l.get("id"))
                for l in lens_lanes
                if isinstance(l, dict) and l.get("run") is not None}
    checkout_by_id = {str(l.get("id")): str(l.get("checkout_path") or "")
                      for l in (lanes.get("lanes") or [])
                      if isinstance(l, dict)}
    at_main_by_id = {str(l.get("id")): bool(l.get("at_main"))
                     for l in (lanes.get("lanes") or [])
                     if isinstance(l, dict)}
    diff_states = []
    if busy_ids and checkout_by_id:
        for lid in sorted(busy_ids):
            wd = checkout_by_id.get(lid)
            if not wd or not os.path.isdir(wd):
                continue
            # skip clean-at-main busy lanes (just started, no commits yet)
            if at_main_by_id.get(lid, False):
                fp, ch = diff_fingerprint(wd)
                if fp is not None and not ch:
                    continue
            ds = compute_diff_state(f"akari-lane-{lid}", wd)
            if ds:
                diff_states.append(ds)
    if diff_states:
        L.append(f"akari lane-diff({len(diff_states)}):")
        for d in diff_states:
            fp8 = d["fp"][:8]
            nchg = len(d.get("changed") or [])
            stat = d.get("stat") or ""
            stat_part = f" {stat}" if stat else ""
            nc = len(d.get("commits") or [])
            nc_part = f" 新提交{nc}条" if nc else " 无新提交"
            L.append(f"  lane-{d['tag'].rsplit('-', 1)[-1]}: fp={fp8} "
                     f"改{nchg}文件{stat_part}{nc_part}")
            for c in (d.get("commits") or [])[:DIFF_MAX_COMMITS]:
                L.append(f"    {c}")

    return L


def akari_jobs_block():
    """Multi-line akari job-level watch block, or "" when akari is idle.
    READ-ONLY: three GETs (lens/lanes + workers + asks), a fourth (lanes) only
    when a busy lane may need a diff. Each call is curl -m 3 fault-tolerant;
    akari down -> "" (the waker survives, akari_brief still shows its line).

    Placed in the briefing at 区间汇总 同级视野 (top, can't-miss) so akari job
    terminal states — successes AND failures — never silently vanish (CW §9),
    matching the prominence of 新旗/完成. Idle (no live jobs, no recent
    terminals, no pending asks) -> "" -> no noise (akari_brief stays the one line)."""
    lens = _akari_get("/api/lens/lanes")
    if not lens:
        return ""  # akari down / lens unreachable -> no block, no crash
    workers = _akari_get("/api/workers") or {}
    asks = _akari_get("/api/asks") or {}
    # lanes (checkout_path for diff) only when there's a busy lane or a terminal
    lanes = {}
    busy = any(isinstance(l, dict) and l.get("run") is not None
               for l in (lens.get("lanes") or []))
    if busy:
        lanes = _akari_get("/api/lanes") or {}
    lines = akari_jobs_lines(lens, workers, asks, lanes, now_utc())
    return "\n".join(lines) if lines else ""


def _clean_pct(s):
    """Strip a trailing .0 from a percentage string so 90.0 -> 90, 89.5 -> 89.5."""
    if s.endswith(".0"):
        return s[:-2]
    return s


def _parse_usage(line):
    """Extract (5h_pct, 7d_pct, fable_pct) from a usage_snap.log line, or None.
    fable_pct is the per-team fable allowance (主人 2026-07-30 passthrough); None
    when the line has no fable= field (older snapshots)."""
    m5 = re.search(r'5h=([0-9.]+)%', line)
    m7 = re.search(r'7d=([0-9.]+)%', line)
    if not m5 or not m7:
        return None
    mf = re.search(r'fable=([0-9.]+)%', line)
    fable = _clean_pct(mf.group(1)) if mf else None
    mr = re.search(r'reset5h=([0-9T:-]+)', line)
    reset5h = mr.group(1) if (mr and mr.group(1)) else None
    return (_clean_pct(m5.group(1)), _clean_pct(m7.group(1)), fable, reset5h)


# 2026-07-31 主人令：四池(T1/T2/T3/T4) config-dir → team 标签映射（长前缀先匹配，
# 冒号消歧，避免 ".claude:" 误匹配 team2/3/4）。
_TEAM_PREFIX = [("T4", ".claude-team4:"), ("T3", ".claude-team3:"),
                ("T2", ".claude-team2:"), ("T1", ".claude:")]

def _collect_teams(data):
    """Scan a usage_snap.log tail (newest-first) → {'T1':tuple|None, ... 'T4':...}.
    tuple = (5h, 7d, fable, reset5h); None when the pool line is absent or
    NOT_LOGGED_IN/SNAP_ERR (unparseable)."""
    res = {"T1": None, "T2": None, "T3": None, "T4": None}
    seen = set()
    for line in reversed(data.splitlines()):
        line = line.strip()
        if not line:
            continue
        for tk, pfx in _TEAM_PREFIX:
            if tk not in seen and pfx in line:
                seen.add(tk)
                res[tk] = _parse_usage(line)  # None for NOT_LOGGED_IN/SNAP_ERR
                break
        if len(seen) == 4:
            break
    return res

def usage_values():
    """Return {'T1'..'T4': (5h,7d,fable,reset5h)|None, 'stale': bool} from usage_snap.log."""
    try:
        with open(USAGE_LOG, "rb") as f:
            f.seek(0, 2); sz = f.tell(); f.seek(max(0, sz - 16384))
            data = f.read().decode("utf-8", "replace")
        fmtime = os.path.getmtime(USAGE_LOG)
    except Exception:
        return {"T1": None, "T2": None, "T3": None, "T4": None, "stale": True}
    res = _collect_teams(data)
    res["stale"] = (now_utc() - fmtime) > USAGE_STALE_MIN
    return res


# 搬家预案（主人 2026-07-17）：秘书 team 5h>=90% 或 7d>=95% -> 立即报警拍
# （绕过 20-min 门），提醒秘书执行 SECRETARY_MIGRATION.md。半小时最多一次。
USAGE_ALARM_5H = float(os.environ.get("WAKE_USAGE_ALARM_5H", "90"))
USAGE_ALARM_7D = float(os.environ.get("WAKE_USAGE_ALARM_7D", "95"))
_last_usage_alarm = [0.0]

def usage_alarm_line():
    """Return an alarm string when the secretary team crosses thresholds, else None."""
    if SECRETARY_TEAM not in ("T1", "T2", "T3", "T4"):
        return None
    u = usage_values().get(SECRETARY_TEAM)
    if not u:
        return None
    try:
        h5, d7 = float(u[0]), float(u[1])
    except (TypeError, ValueError):
        return None
    if h5 >= USAGE_ALARM_5H or d7 >= USAGE_ALARM_7D:
        if now_utc() - _last_usage_alarm[0] < 1800:
            return None
        _last_usage_alarm[0] = now_utc()
        return (f"‼️ 用量告警: 秘书@{SECRETARY_TEAM} 5h={h5:g}% 7d={d7:g}% 已达搬家阈值"
                f"(5h>={USAGE_ALARM_5H:.0f}% 或 7d>={USAGE_ALARM_7D:.0f}%) — "
                f"按 ~/code/worker-core/SECRETARY_MIGRATION.md 立即执行搬家预案")
    return None


def usage_brief():
    """One-line usage for all four pools + recovery time, e.g.
    `usage: T1 5h=82% 7d=50% fable=90% r5h=20:49 | T2 ... | T3 ... | T4 (未登录) | 秘书@T3F`.
    Reads the latest .claude/.claude-team2/3/4 lines from usage_snap.log. READ-ONLY
    — never calls the API (zero cost). `(stale)` if snapshot >40 min old.
    2026-07-31 主人令：四池 + 恢复时间(5h reset)。"""
    try:
        with open(USAGE_LOG, "rb") as f:
            f.seek(0, 2); sz = f.tell(); f.seek(max(0, sz - 16384))
            data = f.read().decode("utf-8", "replace")
        fmtime = os.path.getmtime(USAGE_LOG)
    except Exception:
        return "usage: (no snapshot)"
    stale = (now_utc() - fmtime) > USAGE_STALE_MIN
    vals = _collect_teams(data)

    def _fmt(tk):
        u = vals.get(tk)
        if not u:
            return f"{tk} (未登录/无)"
        s = f"{tk} 5h={u[0]}% 7d={u[1]}%"
        if u[2] is not None:
            s += f" fable={u[2]}%"
        if len(u) > 3 and u[3]:
            s += f" r5h={u[3][-5:]}"  # tail = HH:MM
        return s

    parts = " | ".join(_fmt(t) for t in ("T1", "T2", "T3", "T4"))
    s = f"usage: {parts} | 秘书@{SECRETARY_TEAM}"
    if stale:
        s += " (stale)"
    return s


# ---------------- V5 lightweight per-task diff snapshot (2026-07-30) ----------------
# Per the design doc REPORT_historian_diff_review_merge_design.md, this is the
# LIGHTWEIGHT layer only: a content-stable, cached diff fingerprint per running
# task + changed-file/diff-stat line + new-commit summary (<=5/tree). The LLM
# critic subprocess (critic_worker.py), decide_critic spawn/reuse/defer/pending,
# quiet-hours gate, and PACE speed judgment are NOT this phase (deferred — see
# REPORT gap section). The historian red line holds: all git calls are
# read-only; state is written only under STATE_DIR (diff_fp/diff_head/diff_cache).

def manifest_workdir(tag):
    """Parse the WD (worktree) field from watchdog-manifest.txt `TAG|WD|MODEL`.
    Returns the absolute worktree path or None (tag absent / no WD field / not a
    dir). The manifest is the authoritative focus list already read by
    read_manifest_tags(); this re-reads it (cheap, 2 entries) to get the WD."""
    try:
        with open(MANIFEST) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("|")
                if len(parts) >= 2 and parts[0].strip() == tag:
                    return parts[1].strip() or None
    except Exception:
        pass
    return None


def diff_fingerprint(worktree, timeout=8):
    """Content-stable, cheap, read-only diff fingerprint (design doc S4).
    Returns (fingerprint_hex, changed_files_list) or (None, []).
      head  = git rev-parse HEAD          (new commit flips fp)
      porc  = git status --porcelain -z   (staging state)
      names = git diff --name-only        (tracked working-tree changes vs HEAD)
      untr  = git ls-files --others       (untracked, not ignored)
      blobs = git hash-object per changed file (EXACT working-tree blob SHA —
             any content edit flips the fp, no edge collision unlike --stat)
    fp = sha1(head \\0 porc \\0 changed \\0 blobs). Bounded: DIFF_MAX_CHANGED files;
    per-command timeout. Clean worktree -> changed=[] -> stable fp -> reuse.
    Returns (None, []) on git failure (not a repo / broken) -> diff skipped."""
    if not worktree or not os.path.isdir(worktree):
        return None, []
    rc_head, head = run_cmd(["git", "-C", worktree, "rev-parse", "HEAD"], timeout)
    if rc_head is None or rc_head != 0:
        return None, []
    _rc_p, porc = run_cmd(["git", "-C", worktree, "status", "--porcelain=v1", "-z"], timeout)
    _rc_n, names = run_cmd(["git", "-C", worktree, "diff", "--name-only"], timeout)
    _rc_u, untr = run_cmd(["git", "-C", worktree, "ls-files", "--others", "--exclude-standard"], timeout)
    changed = sorted(set((names or "").splitlines()) | set((untr or "").splitlines()))
    blobs = []
    for f in changed[:DIFF_MAX_CHANGED]:
        rc_h, h = run_cmd(["git", "-C", worktree, "hash-object", "--", f], timeout=3)
        blobs.append(h.strip() if (rc_h == 0 and h) else "?")
    blob = "\0".join([head.strip(), porc or "", "\n".join(changed), "\n".join(blobs)])
    return hashlib.sha1(blob.encode()).hexdigest(), changed


def diff_stat_summary(worktree, timeout=8):
    """One-line `git diff --shortstat` (working tree vs HEAD), e.g.
    '3 files changed, 45 insertions(+), 12 deletions(-)'. Returns '' on
    failure or a clean tree (no working-tree changes). Untracked files are NOT
    in --shortstat (only tracked modifications) — the 改N文件 count from the
    fingerprint includes them, so the two may differ when untracked files
    exist; that is expected for a lightweight snapshot."""
    rc, out = run_cmd(["git", "-C", worktree, "diff", "--shortstat"], timeout)
    if rc != 0 or not out:
        return ""
    return out.strip()


def new_commits(worktree, old_head, timeout=8):
    """`git log old_head..new_head --oneline` (new commits since the last
    fingerprint's HEAD), capped at DIFF_MAX_COMMITS (5) lines. Returns a list
    of oneline strings. Empty when old_head is unset (first beat), old==new
    (no advance), or git fails."""
    rc_nh, new_head = run_cmd(["git", "-C", worktree, "rev-parse", "HEAD"], timeout)
    if rc_nh != 0 or not new_head:
        return []
    new_head = new_head.strip()
    if not old_head or old_head == new_head:
        return []
    rc, out = run_cmd(["git", "-C", worktree, "log", "--oneline",
                       f"{old_head}..{new_head}"], timeout)
    if rc != 0 or not out:
        return []
    return [ln.strip() for ln in out.splitlines() if ln.strip()][:DIFF_MAX_COMMITS]


def compute_diff_state(tag, workdir):
    """Per-task diff snapshot with caching (the "without rereading unchanged
    code" requirement). Returns a dict for build_diff_block, or None when the
    task has no workdir / git fails. Cache keys (STATE_DIR):
      diff_fp_<tag>    — last fingerprint (the "did it change" baseline)
      diff_head_<tag>  — last HEAD sha (for new-commit computation)
      diff_cache_<tag> — JSON {changed, stat, commits} (reused when fp unchanged)
    When the fingerprint is UNCHANGED since the last beat, diff_stat_summary
    and new_commits git calls are SKIPPED and the cached values reused — the
    beat never rereads unchanged code. Only when the fp changes (or first
    beat) are stat + commits recomputed and the cache refreshed."""
    if not workdir or not os.path.isdir(workdir):
        return None
    fp, changed = diff_fingerprint(workdir)
    if fp is None:
        return None
    last_fp = load_state(f"diff_fp_{tag}", "")
    last_head = load_state(f"diff_head_{tag}", "")
    try:
        cache = json.loads(load_state(f"diff_cache_{tag}", "{}") or "{}")
    except Exception:
        cache = {}
    if fp == last_fp and cache:
        # UNCHANGED — reuse cached stat/changed/commits, skip git diff/log.
        # Re-save fp so a state-wipe is detectable; do NOT touch diff_head.
        save_state(f"diff_fp_{tag}", fp)
        return {"tag": tag, "fp": fp, "changed": cache.get("changed", []),
                "stat": cache.get("stat", ""), "commits": cache.get("commits", []),
                "reused": True}
    # CHANGED (or first beat) — recompute stat + commits, refresh cache.
    stat = diff_stat_summary(workdir) if changed else ""
    commits = new_commits(workdir, last_head) if last_head else []
    save_state(f"diff_fp_{tag}", fp)
    rc_h, hd = run_cmd(["git", "-C", workdir, "rev-parse", "HEAD"], 8)
    if rc_h == 0 and hd:
        save_state(f"diff_head_{tag}", hd.strip())
    save_state(f"diff_cache_{tag}", json.dumps(
        {"changed": changed, "stat": stat, "commits": commits}))
    return {"tag": tag, "fp": fp, "changed": changed, "stat": stat,
            "commits": commits, "reused": False}


def build_diff_block(running, diff_states):
    """Lightweight per-task diff snapshot block, appended to the briefing
    after the 在跑(...) section. Only running tasks WITH a workdir+git repo
    appear. Each line: fp=<8hex> + 改N文件 + diff-stat + new-commit summary
    (<=5/tree). Returns None (no block) when no task has a diff state — so
    empty-board silence, the survival ping, and the V4.4 dedup are untouched.
    No ticking clock (the LLM critic's `next Nmin` is deferred), so
    normalize_briefing needs no new regex: an unchanged block is byte-identical
    -> dedup fires; a real fp/stat/commit change breaks the dup (desired)."""
    states = [d for d in diff_states if d]
    if not states:
        return None
    L = [f"diff快照({len(states)}):"]
    for d in states:
        fp8 = d["fp"][:8]
        changed = d["changed"]
        nchg = len(changed)
        stat = d["stat"]
        stat_part = f" {stat}" if stat else ""
        nc = len(d.get("commits") or [])
        nc_part = f" 新提交{nc}条" if nc else " 无新提交"
        L.append(f"  {d['tag']}: fp={fp8} 改{nchg}文件{stat_part}{nc_part}")
        # changed-file list when small (<=8) and non-empty
        if 0 < nchg <= 8:
            for f in changed[:8]:
                L.append(f"    {f}")
        # new commit summary (<=5 lines per tree)
        for c in (d.get("commits") or [])[:DIFF_MAX_COMMITS]:
            L.append(f"    {c}")
    L.append("▸ 秘书：以上为缓存 diff 快照，派工前请先看活态(loop日志/端口/worktree)")
    return "\n".join(L)


def build_interval_summary(new_sigs, running, task_snap, span_sec=None):
    """V4.4 区间汇总: aggregate the window since the last briefing (vs the
    last task_snapshot). Deterministic, zero-LLM. Returns a multi-line block
    (without a header) or None when nothing happened in the window.
    V6: the header span reflects the ACTUAL elapsed seconds since the last
    successful briefing (span_sec), e.g. 区间汇总(23min) after a 3-min backoff
    chain — not a hardcoded 20min. Defaults to BRIEF_INTERVAL when unset
    (--brief diagnostic / first briefing).
      新旗/新失败/新自旋 — new FLAG_/FAILSIG_/SPIN_ since last briefing
      完成    — tasks that were running last time and now have a FLAG_<tag>
      新增    — running now but not in the last snapshot
      消失    — in the last snapshot but gone now and NOT flagged (abandoned)
      进展    — per persisted task: iter delta + whether the log advanced"""
    new_flags = sorted(s for s in new_sigs if s.startswith("FLAG_"))
    new_fails = sorted(s for s in new_sigs if s.startswith("FAILSIG_"))
    new_spins = sorted(s for s in new_sigs if s.startswith("SPIN_"))
    new_done  = sorted(s for s in new_sigs if s.endswith("_DONE") and not s.startswith(SIG_PREFIXES))
    cur_tags  = {t["tag"] for t in running}
    snap_tags = set((task_snap or {}).keys())
    new_tasks = sorted(cur_tags - snap_tags)
    gone      = snap_tags - cur_tags
    completed = sorted(t for t in gone if os.path.exists(os.path.join(SIGNAL_DIR, f"FLAG_{t}")))
    vanished  = sorted(t for t in gone if t not in completed)
    persisted = sorted(cur_tags & snap_tags)
    L = []
    if new_flags: L.append("  新旗: " + " ".join(new_flags))
    if new_fails: L.append("  新失败: " + " ".join(new_fails))
    if new_spins: L.append("  新自旋: " + " ".join(new_spins))
    if new_done:  L.append("  新完成标志: " + " ".join(new_done))
    if completed: L.append("  完成: " + " ".join(completed))
    # task_snap None = first post-upgrade briefing (no task baseline yet): skip
    # 新增 — snap_tags is empty so every running task would falsely appear as
    # new. task_snapshot is saved after this briefing (beat step 5), so the
    # next one has a real baseline and 新增/消失/进展 compare correctly.
    if new_tasks and task_snap is not None: L.append("  新增: " + " ".join(new_tasks))
    if vanished:  L.append("  消失: " + " ".join(vanished))
    if persisted:
        L.append("  进展:")
        cur_map = {t["tag"]: t for t in running}
        for tag in persisted:
            cur = cur_map[tag]
            sn = (task_snap or {}).get(tag, {})
            ci, si = cur["iter"], sn.get("iter")
            same_last = cur["last"] == sn.get("last")
            if ci is not None and si is not None:
                d = ci - si
                iter_part = f"iter {si}→{ci} ({'+' if d >= 0 else ''}{d})"
                no_prog = (d == 0 and same_last)
            elif ci is not None:
                iter_part = f"iter {ci}"
                no_prog = same_last
            else:
                iter_part = "iter?"
                no_prog = same_last
            if no_prog:
                L.append(f"    {tag}: {iter_part} 无新输出")
            else:
                L.append(f"    {tag}: {iter_part} …{cur['last']}")
    if not L:
        return None
    span = span_sec if span_sec is not None else BRIEF_INTERVAL
    span_min = max(1, int(span / 60 + 0.5))   # round half-up; cosmetic + dedup-normalized
    return f"区间汇总({span_min}min):\n" + "\n".join(L)


def build_briefing(new_sigs, all_stalls, running, beat_no, stats, task_snap=None,
                   pending=None, span_sec=None, term_gap=None, report_fails=None,
                   diff_block=None, akari_block=None):
    hhmm = time.strftime("%H:%M")
    L = [f"[史官简报 {hhmm}]"]
    # V4.5 (2026-07-29) terminal-signal gap alerts — placed FIRST, above the
    # interval summary, so the master cannot miss them. A vanished task with no
    # terminal signal is the mes13819 incident: the historian stayed silent for
    # ~5h. report_fails escalates the wording when the report itself explicitly
    # says FAIL/BLOCKED but no FAILSIG/BLOCKED was touched (exit 0 != success).
    if term_gap:
        for _t in sorted(term_gap):
            _fl = (report_fails or {}).get(_t)
            if _fl:
                L.append(f"‼️ 终态异常消失: {_t} — 报告显式FAIL但无FAILSIG（exit 0≠success）"
                         f"「{_fl}」请补 FAILSIG 或确认收工")
            else:
                L.append(f"‼️ 终态异常消失: {_t} — 在跑中消失且无终态信号(FLAG/FAILSIG/"
                         f"SPIN/BLOCKED)，请确认是否真的收工或需补信号")
    # V4.4 interval summary replaces the old standalone "新信号" line: it lists
    # new FLAG_/FAILSIG_/SPIN_ by kind PLUS task lifecycle + per-task progress.
    # V6: span_sec = seconds since the last successful briefing (dynamic header).
    summ = build_interval_summary(new_sigs, running, task_snap, span_sec=span_sec)
    if summ:
        L.append(summ)
    # 2026-07-31 史官纳管 akari：akari job-level watch block。与「区间汇总」同级
    # 视野（紧随其后），终态成功/失败与新旗/完成并排 — 失败绝不会悄悄消失（CW §9）。
    # akari 空闲时 akari_block="" -> 无噪声（akari_brief 那行照常显示）。akari 挂了
    # 也只返回 "" -> 史官不跟着崩。
    if akari_block:
        L.append(akari_block)
    # V4.4 待批复 — highest-priority decision points waiting on the master.
    # `pending` = {tag: {"beats": N, "line": "..."}} where beats is the number of
    # consecutive SENT briefings the marker has survived (incremented only on a
    # real send, so dedup/routine-gate skips do not inflate it). ‼️ escalates at
    # >=2 beats so a lingering request can never silently rot. Most-waiting first.
    if pending:
        L.append(f"待批复({len(pending)}条):")
        for tag in sorted(pending, key=lambda t: (-pending[t]["beats"], t)):
            b = pending[tag]["beats"]
            esc = "‼️ " if b >= 2 else ""
            L.append(f"  {esc}{tag} 等了{b}拍 — {pending[tag]['line']}")
    if all_stalls:
        L.append("停滞告警: " + " ".join(sorted(all_stalls)))
    L.append(f"在跑({len(running)}条):")
    for t in sorted(running, key=lambda x: x["age"]):  # most-recent first
        spin = " SPIN" if t["spin"] else ""
        it = f"iter{t['iter']}" if t["iter"] is not None else "iter?"
        mark = " ⚠停滞" if t["age"] > STALL_MIN else ""
        L.append(f"  {t['tag']}({t['age']/60:.0f}分钟前|{it}){spin}{mark} …{t['last']}")
    # V5 lightweight diff snapshot (cached fingerprint, <=5 new commits/tree).
    # Appended after 在跑 so the runtime snapshot still leads; None when no
    # running task has a worktree (empty board -> no block -> silence untouched).
    if diff_block:
        L.append(diff_block)
    tb = tmux_brief()
    L.append(f"tmux: {' '.join(tb) if tb else '(无)'}")
    L.append(f"端口: {port_brief()}")
    L.append(akari_brief())
    L.append(usage_brief())
    sk = " ".join(f"{k}:{v}" for k, v in sorted(stats.get("skip", {}).items()) if v)
    L.append(f"waker自检: 第{beat_no}拍 {'跳过 ' + sk if sk else '无跳过'} | {ANCHOR}")
    return "\n".join(L)


def normalize_briefing(msg):
    """V4.4 dedup canonical form. Strips the naturally-drifting fields so two
    briefings are compared on SUBSTANTIVE content only (master: '连续两拍无
    差别就别发'):
      - the [史官简报 HH:MM] timestamp header
      - the waker自检: 第N拍 … beat-number line
      - the usage: … snapshot line (drifts independently — master listed it)
      - the (N分钟前| age in each 在跑 line. Age is a ticking clock, not
        information: a task sitting idle grows its age every minute, which is
        not a change worth reporting. Without stripping it the dedup would
        never fire during a frozen period (exactly when the master wants it
        quiet), so the age is normalized away alongside the other drift
        fields. This is the same category as timestamp/拍号/usage which the
        master explicitly named.
      - the 等了N拍 counter in each 待批复 line. The counter ticks once per
        SENT briefing, so a lingering request (same decision point, just
        waiting longer) would otherwise break the dup every beat and re-send
        every 20 min — the exact noise the master wants suppressed. The ‼️
        escalation prefix (fires once at >=2 beats) is KEPT: it is a one-time
        state change, not drift, so the escalation beat still breaks the dup
        and sends, but subsequent identical-wait beats go quiet.
    Any substantive change (signals / interval summary / running SET / iter /
    last_line / stalls / ports / akari) breaks the dup and resumes sending."""
    out = []
    for ln in msg.split("\n"):
        s = ln.strip()
        if s.startswith("[史官简报 ") or s.startswith("waker自检:") or s.startswith("usage:"):
            continue
        s = re.sub(r'区间汇总\(\d+min\)', '区间汇总', s)   # V6: span minute count is drift, not info
        s = re.sub(r'\(\d+分钟前\|', '(|', s)   # strip drifting age in running lines
        s = re.sub(r'等了\d+拍', '等了拍', s)    # strip drifting beat counter in 待批复 (‼️ kept)
        out.append(s)
    return "\n".join(out).strip()


# ---------------- inject ----------------

def do_inject(msg, urgent=False):
    """Return True only for confirmed injection (or DRY simulation).

    Codex terminal injection is fail-closed: None means both transport frames
    were sent but submission was not observable. The exact same payload is then
    quarantined instead of being re-sent into a possibly populated input box.
    urgent=True -> wake-secretary sendNow (HTTP inject, interrupts mid-turn).
    """
    if not LIVE:
        logmsg("DRY-RUN would-inject briefing:")
        for ln in msg.split("\n"):
            logmsg(f"  BRIEF| {ln}")
        return True
    if (WAKE_TABTYPE == "codex"
            and load_state("codex_unconfirmed_payload", "") == msg):
        logmsg("SKIP codex re-send — identical payload was sent but submission "
               "was not confirmed")
        return None
    env = dict(os.environ, WAKE_SENDNOW="1") if urgent else None
    rc, out = run_cmd(["python3", WAKE_PY, msg], timeout=20, env=env)
    if WAKE_TABTYPE == "codex":
        result = {}
        for line in reversed((out or "").splitlines()):
            try:
                result = json.loads(line)
                break
            except (TypeError, ValueError):
                continue
        submitted = result.get("submitted") is True
        ok = rc == 0 and result.get("ok") is True and submitted
        if (result.get("sent_text") is True
                and result.get("sent_enter") is True
                and not submitted):
            save_state("codex_unconfirmed_payload", msg)
            logmsg("CODEX inject unconfirmed — text+Enter frames sent, no "
                   "submission evidence; payload quarantined from re-send")
            return None
        if ok:
            save_state("codex_unconfirmed_payload", "")
    else:
        ok = (rc == 0)
    logmsg(f"LIVE inject rc={rc} ok={ok} out={(out or '').strip()[:240]}")
    return ok


# ---------------- main beat ----------------

def beat():
    global LIVE, MODE
    now = now_utc()
    inc_stat("beat")
    stats = load_stats()
    beat_no = stats.get("beat", 0)

    # 1. busy gate (anti-collision: master typing right now, user-only).
    #    Claude tabs read the secretary JSONL for "master is typing"; a CODEX
    #    terminal tab has no JSONL, so the anti-collision gate is relaxed for
    #    codex — the rate-limit / hourly-cap / routine-interval / dup gates
    #    below still protect against spam. jp=None -> last_activity_ts returns
    #    None -> decide_routine treats None as not-在聊 (no backoff).
    jp = None
    if WAKE_TABTYPE == "claude":
        jp = latest_jsonl()
        if not jp:
            # 自我保护（主人 2026-07-22）：连续空转（找不到秘书会话）→ 休眠停报，
            # ntfy 一次，等会话文件恢复自动复工或主人处置。防止对着死目标空烧。
            streak = int(load_state("nojsonl_streak", "0")) + 1
            save_state("nojsonl_streak", str(streak))
            if streak == 3:
                ntfy("史官休眠：连续3拍找不到秘书会话(jsonl)。已停止汇报，等主人处置或会话恢复。")
                logmsg("DORMANT armed after 3 consecutive no-jsonl beats — briefings halted")
            if streak >= 3:
                logmsg(f"SKIP no-jsonl-found (dormant, streak={streak})")
                return
            logmsg("SKIP no-jsonl-found")
            inc_stat("no_jsonl")
            return
        if int(load_state("nojsonl_streak", "0")) >= 3:
            ntfy("史官复工：秘书会话已恢复可见。")
            logmsg("DORMANT lifted — jsonl visible again, resuming briefings")
        save_state("nojsonl_streak", "0")
        last = last_user_ts(jp)
        _busy = last is not None and (now - last) < BUSY_SEC
        if _busy:
            # 打断机制（主人 2026-07-17）：先快扫 interrupt 级事件；没有才让路。
            _quick_prev = load_snapshot()
            _quick_new = (scan_signals() - _quick_prev) if _quick_prev is not None else set()
            _quick_reasons = interrupt_reasons(_quick_new, usage_alarm_line())
            if not _quick_reasons:
                # V6: routine 到拍但主人正在打字 → 退避 3min 重试 (不是等整拍 270s)，
                # 形成 23/26/29 链式复查。不发不前移 last_brief。
                if (now - float(load_state("last_brief", "0") or 0)) >= BRIEF_INTERVAL:
                    _sleep_hint[0] = RETRY_SEC
                    logmsg(f"SKIP busy age={now-last:.0f}s < {BUSY_SEC}s (master typing) "
                           f"— routine due, retry in {RETRY_SEC}s (V6 backoff)")
                else:
                    logmsg(f"SKIP busy age={now-last:.0f}s < {BUSY_SEC}s (master typing) "
                           f"— briefing kept pending")
                inc_stat("busy")
                return  # do NOT consume snapshot -> stays pending for the quiet moment
            logmsg(f"INTERRUPT overrides busy gate: {'; '.join(_quick_reasons)}")
    else:
        # CODEX terminal tab: no Claude JSONL -> no anti-collision signal. Keep
        # the dormant streak reset so a later switch back to claude resumes clean
        # (never arms DORMANT on a jsonl-less codex tab).
        save_state("nojsonl_streak", "0")
    # not busy, codex tab (no anti-collision signal), or interrupt-class event -> proceed

    # 1.5 V5 heartbeat death detection (claude tabs, LIVE only). Returns True
    #     when a probe was sent or death declared -> skip the briefing (a dead
    #     secretary won't consume it; the probe/death alert already went out).
    if check_heartbeat(now):
        return

    # 2. gather current state (read-only full sweep)
    running = running_tasks()
    write_army_status(running)
    cur_sigs = scan_signals()
    cur_stalls = stalled_set(running)
    cur_pending = scan_pending_approvals()   # V4.4 待批复 — {tag: one-line}
    sig_prev = load_snapshot()

    # baseline on first beat (no inject): mark all current signals as already-
    # known so pre-existing ones don't flood the interval summary, and seed the
    # timers + task snapshot so the first routine briefing is a full
    # BRIEF_INTERVAL away (and its interval summary is well-formed).
    if sig_prev is None:
        save_snapshot(cur_sigs)
        save_stall_snapshot(cur_stalls)
        save_state(f"last_inj_{MODE}", "0")
        save_state("last_brief", f"{int(now)}")   # V4.4: routine gate seeded to now
        save_task_snapshot({t["tag"]: {"iter": t["iter"], "last": t["last"]}
                            for t in running})
        save_coverage({t["tag"] for t in running})
        logmsg(f"BASELINE init: {len(cur_sigs)} signals, {len(cur_stalls)} stalled, "
               f"{len(running)} running (no inject on first beat; first routine "
               f"briefing in {BRIEF_INTERVAL}s)")
        return

    new_sigs = cur_sigs - sig_prev
    # V4.4 alert = NEW stall (task just crossed the 25-min threshold since the
    # last briefing), not every persistent stall — otherwise one long-stalled
    # task would bypass the 20-min gate every 270s and defeat V4.4. A stall
    # that was already reported stays in 停滞告警 (shown each routine briefing)
    # but only newly-stalled tasks trigger an immediate alert.
    prev_stalls = load_stall_snapshot()
    new_stalls = cur_stalls - (prev_stalls or set())

    # V4.5 terminal-signal gap (2026-07-29, mes13819 matrix incident): a task
    # that was running at the last SENT briefing (task_snap) but is gone now
    # with NO terminal signal (FLAG/FAILSIG/SPIN/BLOCKED) is a "无终态信号消失"
    # gap. This is exactly the matrix-runner failure mode the historian silently
    # swallowed for ~5h: worker writes a MATRIX_FAIL report, exits 0, touches no
    # signal, the process dies -> the task drops out of running_tasks() -> with
    # running=0 and no new signal the board fell into empty-board silence. We
    # detect it here (against the persisted task_snap, which is only refreshed
    # on a successful inject, so the vanished task persists across skip beats
    # until the alert actually goes out) and turn it into a prominent ALERT
    # that breaks empty-board silence + bypasses the 20-min routine gate, like a
    # new FAILSIG. report_fails escalates the wording when the report itself
    # explicitly says FAIL/BLOCKED but no FAILSIG/BLOCKED was touched (exit 0 !=
    # success). NB: variable is `term_gap` (a set of tags), not to be confused
    # with the rate-limit `gap` (seconds) computed below.
    task_snap = load_task_snapshot()
    term_gap = detect_terminal_gap(task_snap, running)
    report_fails = {}
    for _t in term_gap:
        _fl = report_fail_firstline(_t)
        if _fl:
            report_fails[_t] = _fl

    # 2.5 interrupt-class events (P0 进展/熔断/空转/用量) bypass all chatter gates
    usage_alarm = usage_alarm_line()
    intr_reasons = interrupt_reasons(new_sigs, usage_alarm, term_gap)
    interrupt = bool(intr_reasons)

    # 3. rate limit (hard insurance) — interrupts keep a 60s floor only
    last_inj = float(load_state(f"last_inj_{MODE}", "0") or 0)
    gap = now - last_inj
    if gap < (60 if interrupt else MIN_GAP):
        logmsg(f"SKIP rate-limit gap={gap:.0f}s — kept pending (interrupt={interrupt})")
        inc_stat("rate")
        return  # do not consume snapshot -> retry next allowed beat
    hc = inject_count_hour()
    if hc >= HOURLY_CAP and not interrupt:
        logmsg(f"SKIP hourly-cap {hc}/{HOURLY_CAP} — kept pending")
        inc_stat("cap")
        return

    # 4. V4.4 routing: ALERT (new signal / stall) injects IMMEDIATELY, bypassing
    #    the 20-min routine gate ("出事不等 20 分钟"). ROUTINE (no alert)
    #    briefings are gated to BRIEF_INTERVAL (20 min). Empty-board silence
    #    (V4.3) is the no-alert + board-empty special case. V4.5 (2026-07-29):
    #    a terminal-signal gap (task vanished with no FLAG/FAILSIG/SPIN/BLOCKED)
    #    is an ALERT too — it must break empty-board silence, never fall into it.
    is_alert = bool(new_sigs or new_stalls or usage_alarm or term_gap)
    if usage_alarm:
        logmsg(f"USAGE ALARM: {usage_alarm}")
    if not is_alert:
        # 4a. V4.3 empty-board silence: running=0 AND no new signals AND no stalls
        #     AND no pending approvals -> do NOT inject the full briefing (not
        #     even "在跑(0条)"). Just log. At most every SURVIVAL_INTERVAL (2h)
        #     send a one-line survival confirmation `[史官] 空板值更中 HH:MM
        #     usage: ...` so the master knows the historian is alive. The survival
        #     timer is SEEDED (not sent) on the first empty-board beat so a
        #     (re)start never pings immediately; reset whenever a real briefing
        #     goes out (step 5). V4.4: a pending 待批复 is an actionable item, so
        #     its presence breaks empty-board silence — the board is NOT empty
        #     and the routine path (4b) reports it at the 20-min cadence.
        # 2026-07-22 akari 时代补盲：旧 army 探测看不见 akari lanes/新式任务 →
        # 误判空板静默。akari 有 lane 开着或 fleet.json 有活 loop 就不算空板。
        _akari_busy = False
        try:
            rc_ak, out_ak = run_cmd(["curl", "-s", "-m", "3",
                f"http://127.0.0.1:{AKARI_PORT}/api/concurrency"], timeout=6)
            if rc_ak == 0 and out_ak:
                d_ak = json.loads(out_ak)
                _akari_busy = int(d_ak.get("running", 0)) > 0  # 只认在跑worker；空lane残留不算活(2026-07-22夜修)
        except Exception:
            pass
        if not running and not cur_pending and _akari_busy:
            running = [{"tag": "akari-lanes", "age": 0, "iter": None,
                        "spin": False, "last": "akari open_lanes>0 (详见 lens 9482)"}]
        if not running and not cur_pending:
            last_surv_str = load_state(f"last_surv_{MODE}", "")
            if not last_surv_str or last_surv_str == "0":
                save_state(f"last_surv_{MODE}", f"{int(now)}")
                save_snapshot(cur_sigs)
                save_stall_snapshot(cur_stalls)
                save_coverage(set())
                logmsg(f"EMPTY-BOARD silent — survival timer seeded; running=0 "
                       f"new_sigs=0 stalls=0; first survival ping in "
                       f"{SURVIVAL_INTERVAL}s")
                inc_stat("empty_board")
                return
            last_surv = float(last_surv_str)
            surv_gap = now - last_surv
            if surv_gap >= SURVIVAL_INTERVAL:
                surv = f"[史官] 空板值更中 {time.strftime('%H:%M')} {usage_brief()}"
                ok = do_inject(surv)
                if ok:
                    append_inject()
                    save_state(f"last_inj_{MODE}", f"{int(now)}")
                    save_state(f"last_surv_{MODE}", f"{int(now)}")
                    save_snapshot(cur_sigs)
                    save_stall_snapshot(cur_stalls)
                    save_coverage(set())
                    if not LIVE:
                        dc = int(load_state("dry_count", "0")) + 1
                        save_state("dry_count", str(dc))
                        if dc >= 3:
                            save_state("auto_live", "1")
                            LIVE = True; MODE = "live"
                            logmsg(f"AUTO-LIVE armed after {dc} dry ticks "
                                   f"(survival) — subsequent beats LIVE")
                        else:
                            logmsg(f"dry tick {dc}/3 (survival confirmation)")
                    logmsg(f"OK survival-confirmation injected (empty board); "
                           f"running=0 new_sigs=0 stalls=0; next in "
                           f"{SURVIVAL_INTERVAL}s hourly={hc+1}/{HOURLY_CAP}")
                else:
                    logmsg("survival-confirmation inject FAILED; state NOT "
                           "consumed (will retry next beat)")
                return
            logmsg(f"SKIP empty-board silent (running=0 new_sigs=0 stalls=0); "
                   f"survival in {SURVIVAL_INTERVAL-surv_gap:.0f}s (last "
                   f"{surv_gap:.0f}s ago)")
            inc_stat("empty_board")
            return
        # 4b. V6 routine gate: board non-empty, no alert -> consult the pure
        #     cadence decision. 到拍但在聊 → 退避 RETRY_SEC 重试 (23/26/29 链)，
        #     不前移 last_brief (发出时区间仍覆盖自上次简报)；到拍不在聊有事件 →
        #     发 (fall through to step 5)；未到拍 → wait。Signals/stalls 走上面的
        #     alert 路径立即发，从不等待这里。空窗 silent 由 4a 兜底 (不前移锚点)。
        last_brief = float(load_state("last_brief", "0") or 0)
        last_msg_ts = last_activity_ts(jp)
        _ev = len(new_sigs) + len(new_stalls) + len(running) + len(cur_pending)
        decision = decide_routine(now, last_brief, last_msg_ts, _ev)
        if decision == "wait":
            brief_gap = now - last_brief
            logmsg(f"SKIP routine not due: last brief {brief_gap:.0f}s ago, "
                   f"next in {BRIEF_INTERVAL-brief_gap:.0f}s "
                   f"(running={len(running)} new_sigs={len(new_sigs)} "
                   f"stalls={len(cur_stalls)}); diff accumulates for next summary")
            inc_stat("routine_wait")
            return
        if decision == "backoff":
            _sleep_hint[0] = RETRY_SEC
            logmsg(f"BACKOFF routine due but 在聊 (last activity "
                   f"{(now-last_msg_ts):.0f}s ago < {CONV_SEC}s) — retry in "
                   f"{RETRY_SEC}s; last_brief NOT moved "
                   f"(span will cover since last brief {(now-last_brief)/60:.0f}min)")
            inc_stat("backoff")
            return   # do NOT consume snapshot / do NOT move last_brief
        if decision == "silent":
            logmsg(f"SKIP routine silent: due but no interval events and not 在聊 "
                   f"— empty window, last_brief NOT moved")
            inc_stat("routine_silent")
            return

    # 5. build + inject the full briefing (alert -> immediate; routine -> 20-min
    #    gate passed). V4.4: include the interval summary vs the last task
    #    snapshot, then refresh that snapshot. V4.5: task_snap was already loaded
    #    at step 2.5 (for detect_terminal_gap); reuse it here (idempotent — the
    #    snapshot file is only written by save_task_snapshot AFTER a successful
    #    inject below, so this is the same data, no stale-read risk).
    # V4.4 待批复 beat projection: a tag's counter ticks once per SENT briefing
    # (not per 270s check), so routine-gate / dedup skips do not inflate "等了N拍".
    # Project prev+1 for every tag still pending; tags whose marker vanished are
    # absent from cur_pending and so drop out on save (auto-remove). The
    # projected state is persisted only after a successful inject below.
    prev_pending = load_pending_state()
    pending_display = {}
    for tag, line in cur_pending.items():
        beats = prev_pending.get(tag, {}).get("beats", 0) + 1
        pending_display[tag] = {"beats": beats, "line": line}
    reason = "alert" if is_alert else "routine"
    # V6: span = seconds since the last SUCCESSFUL briefing (the interval the
    # 区间汇总 header reports). Computed from the pre-update last_brief so an
    # alert or a post-backoff routine send both cover the full elapsed window.
    span_sec = now - float(load_state("last_brief", "0") or 0)
    # V5 lightweight diff snapshot per running task with a worktree (cached
    # fingerprint — unchanged code is NOT reread). Bounded by DIFF_BUDGET; a
    # no-op for tasks without a workdir (tests / codex tabs). Computed here (not
    # earlier) so the V4.4 dedup below sees the diff block in the normalized
    # form: an unchanged diff -> byte-identical block -> dedup fires (frozen
    # quiet); a real fp/stat/commit change breaks the dup (desired news).
    _diff_t0 = now_utc()
    diff_states = []
    for t in running:
        wd = t.get("workdir")
        if not wd:
            continue
        if (now_utc() - _diff_t0) > DIFF_BUDGET:
            logmsg("SKIP diff-budget exceeded — remaining tasks deferred this beat")
            break
        diff_states.append(compute_diff_state(t["tag"], wd))
    diff_block = build_diff_block(running, diff_states)
    # 2026-07-31 史官纳管 akari：beat 里取 job-level watch block（只读 GET，akari 挂
    # 了返回 ""）。放在 diff_block 之后、build_briefing 之前，保持「区间汇总」同级。
    akari_block = akari_jobs_block()
    msg = build_briefing(new_sigs, cur_stalls, running, beat_no, stats,
                        task_snap, pending_display, span_sec=span_sec,
                        term_gap=term_gap, report_fails=report_fails,
                        diff_block=diff_block, akari_block=akari_block)
    if usage_alarm:
        msg = usage_alarm + "\n" + msg
    if interrupt:
        msg = ("‼️【异常禀报】" + "；".join(intr_reasons) +
               "（打断谈话，请主人与秘书一起看）\n") + msg
    # V4.4 dedup (master: 连续两拍无差别就别发): if the normalized briefing is
    # byte-identical to the last one actually SENT, skip injection — only log
    # SKIP dup. Do NOT consume any snapshot/timer so the next beat re-evaluates
    # and the interval diff keeps accumulating; the moment any substantive
    # field changes (signal / running set / iter / last_line / stall / port /
    # akari) the normalized form differs and sending resumes. Alerts reach
    # here too, but an alert by definition adds a 新旗/新失败/新自旋/停滞告警
    # line so it is never a dup of the prior briefing.
    norm = normalize_briefing(msg)
    last_norm = load_state("last_brief_norm", "")
    if last_norm and norm == last_norm:
        logmsg(f"SKIP dup — briefing identical to last sent (normalized); "
               f"{reason} running={len(running)} new_sigs={len(new_sigs)} "
               f"stalls={len(cur_stalls)}; not consumed, re-checked next beat")
        inc_stat("dup")
        return
    ok = do_inject(msg, urgent=interrupt)
    if ok:
        append_inject()
        _hb_track_after_inject(now)  # V5 heartbeat consumption tracking (claude/LIVE only)
        save_state(f"last_inj_{MODE}", f"{int(now)}")  # int() truncates (no round-up future-bias)
        save_state(f"last_surv_{MODE}", f"{int(now)}")  # V4.3: reset survival clock on any real briefing
        save_state("last_brief", f"{int(now)}")         # V4.4: routine gate marker
        save_state("last_brief_norm", norm)             # V4.4: dedup baseline (normalized last sent)
        save_snapshot(cur_sigs)            # consume new signals
        save_stall_snapshot(cur_stalls)
        save_task_snapshot({t["tag"]: {"iter": t["iter"], "last": t["last"]}
                            for t in running})
        # V4.4 待批复: persist the projected beat counters. Tags no longer in
        # cur_pending are absent from pending_display -> auto-removed here, so a
        # marker that vanishes (master approved / done-word appeared) resets to 0
        # and the tag stops being reported. The ‼️ escalation thus only grows
        # while the request genuinely lingers.
        save_pending_state(pending_display)
        # coverage lifecycle: running set is the coverage; FLAG'd tasks already
        # left running (task_info_v4 returns None) and were reported once via
        # the interval summary diff, so they naturally drop out and never repeat.
        new_cov = {t["tag"] for t in running}
        old_cov = load_coverage()
        gone = old_cov - new_cov
        added = new_cov - old_cov
        save_coverage(new_cov)
        if gone or added:
            logmsg(f"coverage: +{len(added)} {sorted(added) if added else ''} "
                   f"-{len(gone)} {sorted(gone) if gone else ''}")
        # auto-live: after 3 dry ticks that actually produced a briefing,
        # cut over to LIVE (persisted so crontab respawn stays LIVE).
        if not LIVE:
            dc = int(load_state("dry_count", "0")) + 1
            save_state("dry_count", str(dc))
            if dc >= 3:
                save_state("auto_live", "1")
                LIVE = True; MODE = "live"
                logmsg(f"AUTO-LIVE armed after {dc} dry ticks — subsequent "
                       f"beats are LIVE (persisted auto_live=1)")
            else:
                logmsg(f"dry tick {dc}/3 (format verification phase)")
        logmsg(f"OK injected/simulated ({reason}); hourly={hc+1}/{HOURLY_CAP} "
               f"gap={gap:.0f}s new_sigs={len(new_sigs)} new_stalls={len(new_stalls)} "
               f"running={len(running)} stalled={len(cur_stalls)} "
               f"pending={len(pending_display)}")
        save_state("inject_fail_streak", "0")
    elif ok is None:
        logmsg("inject UNCONFIRMED; not recorded as success and identical "
               "payload will not be re-sent")
    else:
        logmsg("inject FAILED; snapshots NOT consumed (will retry next beat)")
        # 自锚③：连续失败别哑着——3拍(≈15min)即 ntfy 喊主人/秘书，之后每20拍再喊
        _streak = int(load_state("inject_fail_streak", "0")) + 1
        save_state("inject_fail_streak", str(_streak))
        if _streak == 3 or _streak % 20 == 0:
            ntfy(f"‼️史官注入连续失败{_streak}拍 {ANCHOR} — 简报送不进秘书会话，速查")


# ---------------- selftest ----------------

def run_selftest():
    """Simulated-time demonstration of every V4 gate, writing to a temp log +
    state. Patches now_utc / last_user_ts / scan_signals / scan_pending_approvals
    / running_tasks / discover_tags / tmux_brief / port_brief / do_inject so
    beat() exercises the real decision logic against a scripted, explicitly-timed
    timeline."""
    global LOG, STATE_DIR, SIGNAL_DIR, LIVE, MODE, HOURLY_CAP, MIN_GAP, BUSY_SEC, STALL_MIN, RUN_MAX_AGE, BRIEF_INTERVAL, CHECK_INTERVAL
    import tempfile
    tmp = tempfile.mkdtemp(prefix="waker_selftest_")
    LOG = os.path.join(tmp, "waker.log")
    STATE_DIR = os.path.join(tmp, ".waker")
    SIGNAL_DIR = os.path.join(tmp, "signals")   # isolated so build_interval_summary's FLAG_<tag> existence check (completed vs vanished) is deterministic
    os.makedirs(SIGNAL_DIR, exist_ok=True)
    LIVE = False
    MODE = "dry"
    HOURLY_CAP = 8    # room so the cap does not fire during the demo
    MIN_GAP = 270
    BUSY_SEC = 60
    STALL_MIN = 1500
    RUN_MAX_AGE = 7200
    BRIEF_INTERVAL = 600   # V4.4 routine gate (10 min in sim time)
    CHECK_INTERVAL = 270   # fast check cadence

    fake_now = [0.0]
    signal_set = set()
    master_busy = [False]
    fake_run = [{"tag": "T_X", "age": 600, "iter": 3, "last": "doing thing", "spin": False}]
    flag_set = set()        # tags whose FLAG_<tag> exists
    inject_calls = []
    pending_set = {}        # V4.4 待批复 — {tag: one-line} the fake scanner returns

    def fake_now_utc():
        return fake_now[0]

    def fake_last_user_ts(_path):
        return fake_now[0] - (30 if master_busy[0] else None)

    def fake_last_user_ts_safe(_path):
        # master typing -> 30s ago; idle -> no real user msg (None)
        return fake_now[0] - 30 if master_busy[0] else None

    def fake_scan():
        return set(signal_set)

    def fake_scan_pending():
        return dict(pending_set)

    def fake_discover():
        return [t["tag"] for t in fake_run]

    def fake_running():
        out = []
        for t in fake_run:
            if t["tag"] in flag_set:
                continue
            if t["age"] > RUN_MAX_AGE:
                continue
            out.append(dict(t))
        return out

    def fake_tmux():
        return ["waker(tick)"]

    def fake_ports():
        return "9475✓ 9476✓ 9480✓ 9481✗ 9482✗"

    def fake_akari():
        return "akari: running=2 peak=3 lanes=1/16 ▸ http://«INTERNAL_HOST»:9482"

    def fake_akari_jobs_block():
        # selftest keeps akari idle (no job-level block) so existing assertion
        # counts stay byte-identical; the dedicated --selftest-akari exercises
        # the block itself with faked API JSON.
        return ""

    def fake_usage():
        return "usage: T1 5h=60% 7d=26% | T2 5h=2% 7d=65%"

    def fake_inject(msg, urgent=False):
        inject_calls.append((fake_now[0], msg))
        logmsg("DRY-RUN would-inject briefing:")
        for ln in msg.split("\n"):
            logmsg(f"  BRIEF| {ln}")
        return True

    def fake_inject_live(msg, urgent=False):
        inject_calls.append((fake_now[0], msg))
        logmsg("LIVE inject rc=0 ok=True out={...}")
        for ln in msg.split("\n"):
            logmsg(f"  BRIEF| {ln}")
        return True

    g = globals()
    orig = {k: g[k] for k in ("now_utc", "last_user_ts", "last_activity_ts",
            "scan_signals", "scan_pending_approvals", "discover_tags",
            "running_tasks", "tmux_brief", "port_brief", "akari_brief",
            "akari_jobs_block", "usage_brief", "do_inject", "SIGNAL_DIR")}
    g["now_utc"] = fake_now_utc
    g["last_user_ts"] = fake_last_user_ts_safe
    # V6: the sim does not model the 3-min 在聊 window (master typing is already
    # modelled by the 60s busy gate via fake_last_user_ts_safe). Patch the V6
    # 在聊 data source to None so decide_routine never sees "conversing" and the
    # existing routine-gate steps behave exactly as before (inject count 11).
    g["last_activity_ts"] = lambda _path: None
    g["scan_signals"] = fake_scan
    g["scan_pending_approvals"] = fake_scan_pending
    g["discover_tags"] = fake_discover
    g["running_tasks"] = fake_running
    g["tmux_brief"] = fake_tmux
    g["port_brief"] = fake_ports
    g["akari_brief"] = fake_akari
    g["akari_jobs_block"] = fake_akari_jobs_block
    g["usage_brief"] = fake_usage
    g["do_inject"] = fake_inject

    def step(n, label, busy=False, add_sigs=(), advance=270, set_age=None,
             add_flag=None, add_task=None, set_iter=None, set_last=None,
             set_pending=None):
        logmsg(f"===== SELFTEST step {n}: {label} =====")
        master_busy[0] = busy
        for s in add_sigs:
            signal_set.add(s)
        if add_flag:
            flag_set.add(add_flag)
            signal_set.add(f"FLAG_{add_flag}")
            open(os.path.join(SIGNAL_DIR, f"FLAG_{add_flag}"), "w").close()  # real file so build_interval_summary classifies it 完成 not 消失
        if add_task:
            fake_run.append(dict(add_task))
        if set_age is not None:
            fake_run[0]["age"] = set_age
        if set_iter is not None and fake_run:
            fake_run[0]["iter"] = set_iter
        if set_last is not None and fake_run:
            fake_run[0]["last"] = set_last
        if set_pending is not None:
            pending_set.clear()
            pending_set.update(set_pending)
        beat()
        fake_now[0] += advance

    try:
        logmsg("SELFTEST start — V4.4 gates (routine 20-min gate, alert bypasses "
               "gate, interval summary with iter delta, dedup skip on identical, "
               "busy 60s user-only, auto-live after 3 dry, empty-board silence + "
               "2h survival)")
        step(0, "quiet baseline -> expect BASELINE init (seed last_brief + "
              "task_snap), no inject", advance=270)
        step(1, "master BUSY (user 30s) -> expect SKIP busy",
             busy=True, advance=60)
        step(2, "quiet, only 330s since baseline -> expect SKIP routine not due "
              "(< BRIEF_INTERVAL 600s)", advance=300)
        step(3, "quiet, 630s >= 600 -> expect DRY inject #1 (routine, interval "
              "summary: T_X iter 3->3 no progress)", advance=270)
        step(4, "quiet, 270s since last brief -> expect SKIP routine not due",
             advance=400)
        step(5, "quiet, 670s >= 600 -> expect DRY inject #2; T_X iter bumped "
              "3->5 -> summary shows iter 3->5 (+2)", set_iter=5,
             set_last="did more", advance=600)
        step(6, "quiet, 600s -> expect DRY inject #3 + AUTO-LIVE armed",
             advance=600)
        # switch the inject fake to "live" now that auto_live armed
        g["do_inject"] = fake_inject_live
        step("6b", "LIVE routine, NO change since #3 -> expect SKIP dup (V4.4: "
              "normalized briefing identical to last sent, no inject)",
             advance=600)
        step(7, "LIVE routine, iter bumped 5->7 -> NOT a dup -> expect LIVE "
              "inject #4 (interval summary iter 5->7 +2)", set_iter=7,
              set_last="step seven", advance=600)
        step(8, "ALERT: new FAILSIG_B -> expect LIVE inject #5 IMMEDIATE (bypass "
              "20-min gate) with 新失败 line", add_sigs=("FAILSIG_B",),
             advance=100)
        step(9, "only 100s since inject -> expect SKIP rate-limit", advance=270)
        step(10, "ALERT: T_X FLAGs -> expect LIVE inject #6, interval summary "
               "完成: T_X + 新旗: FLAG_T_X; running empties but signal present "
               "(NOT silent)", add_flag="T_X", advance=270)
        # Simulate a fresh survival timer (never seeded) to exercise the SEED
        # branch of V4.3 empty-board silence.
        try:
            os.remove(_state_file("last_surv_live"))
        except OSError:
            pass
        step(11, "EMPTY BOARD (running=0 new_sigs=0 stalls=0) -> SEED survival "
               "timer, NO inject", advance=270)
        step(12, "empty board +270s -> silent skip (surv_gap<2h), NO inject",
             advance=7200)
        step(13, "empty board +7200s -> SURVIVAL confirmation inject (1 line)",
             advance=270)
        step(14, "ALERT: new task T_Y + SPIN_Y -> LIVE inject #8, summary 新增: "
               "T_Y + 新自旋: SPIN_Y; empty-board silence broken",
             add_sigs=("SPIN_Y",), advance=600,
             add_task={"tag": "T_Y", "age": 600, "iter": 1, "last": "running Y",
                       "spin": False})
        # V4.4 待批复 demo: a pending approval rides the routine 20-min cadence,
        # ‼️-escalates at >=2 beats, and auto-removes the beat its marker vanishes.
        step(15, "待批复 appears (T_Z 等批复) -> LIVE inject #9, 待批复(1条) "
               "T_Z 等了1拍 (no ‼️); breaks no gate, rides routine 600s",
             advance=600, set_pending={"T_Z": "等批复: 采用方案A?"})
        step(16, "待批复 lingers -> LIVE inject #10, ‼️ T_Z 等了2拍 (escalation "
               "at >=2 beats; counter ticks once per sent briefing)",
              advance=600, set_pending={"T_Z": "等批复: 采用方案A?"})
        step("16b", "待批复 lingers, NO other change -> expect SKIP dup (V4.4: "
               "‼️ already fired at #10, beat counter 3 normalized away so the "
               "briefing is identical to #10 -> no inject; a lingering request "
               "must NOT re-send every 20 min)",
              advance=600, set_pending={"T_Z": "等批复: 采用方案A?"})
        step(17, "待批复 marker vanishes -> LIVE inject #11, NO 待批复 section "
               "(auto-removed: pending_state cleared, T_Z drops out)",
              advance=600, set_pending={})
        logmsg("SELFTEST done")
        with open(LOG) as f:
            print("\n--- SELFTEST waker.log ---")
            sys.stdout.write(f.read())
        logmsg(f"SELFTEST inject calls={len(inject_calls)} "
               f"(expect 11: 3 dry routine + 6 live (routine/alert) + 1 survival "
               f"+ 1 待批复 trio; step 6b = SKIP dup V4.4 (identical to #3, no "
               f"inject), step 16b = SKIP dup V4.4 (‼️ already fired, beat "
               f"counter normalized away), steps 2&4 = routine-not-due skips, "
               f"steps 8&10 = alert bypasses the 20-min gate, T_X reported once "
               f"then dropped, empty board silent in between; steps 15-17 = "
               f"待批复 appear/‼️-escalate/auto-remove)")
    finally:
        for k, v in orig.items():
            g[k] = v


def run_gap_selftest():
    """V4.5 terminal-signal gap regression test (2026-07-29, mes13819 incident).

    Covers the 4 required scenarios. Each scenario baselines a fresh task
    (BASELINE-init seeds task_snap), then makes it vanish and asserts the
    briefing does/does not contain the terminal-gap alert:
      A. MATRIX_FAIL report + exit 0 + no signal -> ALERT (报告显式FAIL但无FAILSIG)
      B. no report/signal + process gone       -> ALERT (无终态信号消失)
      C. FLAG + process gone                   -> NO gap alert (legit completion)
      D. FAILSIG/BLOCKED + process gone        -> NO duplicate gap alert
    """
    global LOG, STATE_DIR, SIGNAL_DIR, LIVE, MODE, HOURLY_CAP, MIN_GAP, BUSY_SEC, STALL_MIN, RUN_MAX_AGE, BRIEF_INTERVAL, CHECK_INTERVAL
    import tempfile
    tmp = tempfile.mkdtemp(prefix="waker_gaptest_")
    LOG = os.path.join(tmp, "waker.log")
    STATE_DIR = os.path.join(tmp, ".waker")
    SIGNAL_DIR = os.path.join(tmp, "signals")
    os.makedirs(SIGNAL_DIR, exist_ok=True)
    LIVE = True
    MODE = "live"
    HOURLY_CAP = 99
    MIN_GAP = 0
    BUSY_SEC = 0
    STALL_MIN = 1500
    RUN_MAX_AGE = 7200
    BRIEF_INTERVAL = 600
    CHECK_INTERVAL = 270

    fake_now = [0.0]
    signal_set = set()
    fake_run = []
    flag_set = set()
    pending_set = {}
    inject_calls = []

    def fake_now_utc():
        return fake_now[0]
    def fake_last_user_ts_safe(_p):
        return None
    def fake_scan():
        return set(signal_set)
    def fake_scan_pending():
        return dict(pending_set)
    def fake_discover():
        return [t["tag"] for t in fake_run]
    def fake_running():
        out = []
        for t in fake_run:
            if t["tag"] in flag_set:
                continue
            if t["age"] > RUN_MAX_AGE:
                continue
            out.append(dict(t))
        return out
    def fake_tmux():
        return ["waker(tick)"]
    def fake_ports():
        return "9475✓"
    def fake_akari():
        return "akari: running=0"
    def fake_akari_jobs_block():
        return ""
    def fake_usage():
        return "usage: ok"
    def fake_inject(msg, urgent=False):
        inject_calls.append((fake_now[0], msg))
        logmsg("LIVE inject (gap-test)")
        for ln in msg.split("\n"):
            logmsg(f"  BRIEF| {ln}")
        return True

    g = globals()
    orig = {k: g[k] for k in ("now_utc", "last_user_ts", "last_activity_ts",
            "scan_signals", "scan_pending_approvals", "discover_tags",
            "running_tasks", "tmux_brief", "port_brief", "akari_brief",
            "akari_jobs_block", "usage_brief", "do_inject", "SIGNAL_DIR")}
    g["now_utc"] = fake_now_utc
    g["last_user_ts"] = fake_last_user_ts_safe
    g["last_activity_ts"] = lambda _p: None
    g["scan_signals"] = fake_scan
    g["scan_pending_approvals"] = fake_scan_pending
    g["discover_tags"] = fake_discover
    g["running_tasks"] = fake_running
    g["tmux_brief"] = fake_tmux
    g["port_brief"] = fake_ports
    g["akari_brief"] = fake_akari
    g["akari_jobs_block"] = fake_akari_jobs_block
    g["usage_brief"] = fake_usage
    g["do_inject"] = fake_inject

    results = []
    def check(name, cond, detail=""):
        results.append((name, cond, detail))
        logmsg(f"ASSERT {'PASS' if cond else 'FAIL'}: {name} {detail[:120]}")

    def reset_baseline():
        """Force a fresh BASELINE init on the next beat by deleting the snapshot
        state file, and clear all per-scenario state."""
        try:
            os.remove(_state_file("snapshot"))
        except OSError:
            pass
        signal_set.clear()
        flag_set.clear()
        fake_run.clear()
        for fn in os.listdir(SIGNAL_DIR):
            os.remove(os.path.join(SIGNAL_DIR, fn))

    def last_msg():
        return inject_calls[-1][1] if inject_calls else ""

    try:
        logmsg("GAP SELFTEST start — V4.5 terminal-signal gap (4 scenarios)")

        # --- Scenario A: MATRIX_FAIL report + exit 0 + no signal -> ALERT ---
        reset_baseline()
        fake_run.append({"tag": "T_A", "age": 600, "iter": 1, "last": "running A", "spin": False})
        beat()                      # BASELINE init — seeds task_snap={T_A}, no inject
        fake_now[0] += 270
        # worker writes a FAIL report, exits 0, touches NO signal, process dies
        with open(os.path.join(SIGNAL_DIR, "REPORT_T_A.md"), "w") as f:
            f.write("MATRIX_FAIL: bind export matrix failed\n\ndetails...\n")
        fake_run.clear()            # process gone -> task drops out of running
        beat()                      # ALERT: term_gap={T_A}, report_fails={T_A:...}
        msg_a = last_msg()
        check("A: gap alert present", "终态异常消失: T_A" in msg_a)
        check("A: report-fail wording", "报告显式FAIL但无FAILSIG" in msg_a)
        check("A: not empty-board silent", len(inject_calls) > 0)
        fake_now[0] += 270

        # --- Scenario B: no report/signal + process gone -> ALERT ---
        reset_baseline()
        fake_run.append({"tag": "T_B", "age": 600, "iter": 1, "last": "running B", "spin": False})
        beat()                      # BASELINE init
        fake_now[0] += 270
        fake_run.clear()            # process gone, no report, no signal
        beat()                      # ALERT: term_gap={T_B}, report_fails={}
        msg_b = last_msg()
        check("B: gap alert present", "终态异常消失: T_B" in msg_b)
        check("B: no-signal wording", "无终态信号" in msg_b)
        check("B: NOT report-fail wording", "报告显式FAIL" not in msg_b)
        fake_now[0] += 270

        # --- Scenario C: FLAG + process gone -> NO gap alert (legit completion) ---
        reset_baseline()
        fake_run.append({"tag": "T_C", "age": 600, "iter": 1, "last": "running C", "spin": False})
        beat()                      # BASELINE init
        fake_now[0] += 270
        flag_set.add("T_C")
        signal_set.add("FLAG_T_C")
        open(os.path.join(SIGNAL_DIR, "FLAG_T_C"), "w").close()
        fake_run.clear()            # process gone, but FLAG present -> legit
        beat()                      # ALERT via new_sigs (FLAG), term_gap={} (signal exists)
        msg_c = last_msg()
        check("C: NO gap alert for FLAG'd tag", "终态异常消失: T_C" not in msg_c)
        check("C: completion reported", "完成" in msg_c or "FLAG_T_C" in msg_c)
        fake_now[0] += 270

        # --- Scenario D: FAILSIG + process gone -> NO duplicate gap alert ---
        reset_baseline()
        fake_run.append({"tag": "T_D", "age": 600, "iter": 1, "last": "running D", "spin": False})
        beat()                      # BASELINE init
        fake_now[0] += 270
        signal_set.add("FAILSIG_T_D")
        open(os.path.join(SIGNAL_DIR, "FAILSIG_T_D"), "w").close()
        fake_run.clear()            # process gone, FAILSIG present -> legit fail
        beat()                      # ALERT via new_sigs (FAILSIG), term_gap={} (signal exists)
        msg_d = last_msg()
        check("D: NO gap alert for FAILSIG'd tag", "终态异常消失: T_D" not in msg_d)
        check("D: fail signal reported", "FAILSIG_T_D" in msg_d or "新失败" in msg_d)
        fake_now[0] += 270

        # --- Scenario D2: BLOCKED + process gone -> NO duplicate gap alert ---
        reset_baseline()
        fake_run.append({"tag": "T_D2", "age": 600, "iter": 1, "last": "running D2", "spin": False})
        beat()                      # BASELINE init
        fake_now[0] += 270
        signal_set.add("BLOCKED_T_D2")
        open(os.path.join(SIGNAL_DIR, "BLOCKED_T_D2"), "w").close()
        fake_run.clear()
        beat()                      # ALERT via new_sigs (BLOCKED), term_gap={}
        msg_d2 = last_msg()
        check("D2: NO gap alert for BLOCKED'd tag", "终态异常消失: T_D2" not in msg_d2)

        passed = sum(1 for _, c, _ in results if c)
        total = len(results)
        logmsg(f"GAP SELFTEST done: {passed}/{total} assertions passed")
        with open(LOG) as f:
            print("\n--- GAP SELFTEST waker.log ---")
            sys.stdout.write(f.read())
        if passed != total:
            print(f"\nFAIL: {total - passed} assertion(s) failed:")
            for name, cond, detail in results:
                if not cond:
                    print(f"  FAIL: {name} — {detail}")
            sys.exit(1)
        print(f"\nPASS: all {total} assertions passed")
    finally:
        for k, v in orig.items():
            g[k] = v


def run_iter_selftest():
    """V4.5 iter-boundary regression test (2026-07-29, mes13819 incident).

    The historian must read the runner round ONLY from the runner's own
    anchor lines `=== <tag> iter N ... ===`, never from worker stdout that
    happens to mention `iter N` (e.g. the body of an OLD log file the worker
    is `cat`-ing). Covers:
      1. current runner iter1 + nested old-log body containing `iter 6` -> 1
         (the exact mes13819 incident; old max() logic returned 6).
      2. normal start/end anchors across several rounds -> highest round.
      3. mid-round (start anchor only, no end yet) -> current round.
      4. no anchor at all (fresh LOOP header) -> None.
      5. a DIFFERENT tag's anchor must not be adopted -> own round only.
      6. end-to-end through task_info_v4 reading a real loop_<tag>.log with
         nested `iter 6` old-log content -> task iter == 1 (not 6)."""
    global LOG, STATE_DIR, SIGNAL_DIR
    import tempfile
    tmp = tempfile.mkdtemp(prefix="waker_itertest_")
    LOG = os.path.join(tmp, "waker.log")
    STATE_DIR = os.path.join(tmp, ".waker")
    SIGNAL_DIR = os.path.join(tmp, "signals")
    os.makedirs(SIGNAL_DIR, exist_ok=True)

    results = []
    def check(name, cond, detail=""):
        results.append((name, cond, detail))
        logmsg(f"ITER ASSERT {'PASS' if cond else 'FAIL'}: {name} {detail[:120]}")

    try:
        logmsg("ITER SELFTEST start — V4.5 runner-iter boundary")

        # 1. THE INCIDENT: runner on iter 1, worker cats an old log with iter 6.
        TAG = "mes13819_real_bind_export_matrix_019fa29c_machine"
        data1 = (
            f"=== {TAG} TEAM2-opus OBSERVABLE LOOP start Tue Jul 29 04:00:00 ===\n"
            f"=== {TAG} iter 1 Tue Jul 29 04:01:00 ===\n"
            "Reading ~/codex_work/loop_oldmatrix.log\n"
            "=== oldmatrix_tag iter 6 end exit=0 dur=300s Mon Jul 28 10:00:00 ===\n"
            "old log body: completed iter 6 with export matrix\n"
            f"=== {TAG} iter 1 end exit=0 dur=120s Tue Jul 29 04:03:00 ===\n"
        )
        check("1: nested iter6 ignored -> iter 1",
              parse_runner_iter(TAG, data1) == 1,
              f"got {parse_runner_iter(TAG, data1)!r}")
        # sanity: the OLD logic would have returned 6 here
        old_nums = [int(m) for m in re.findall(r'iter (\d+)', data1)]
        check("1b: OLD logic would be 6 (proves the bug existed)",
              max(old_nums) == 6, f"old max={max(old_nums)}")

        # 2. normal start/end anchors across rounds -> highest round (2).
        data2 = (
            f"=== {TAG} iter 1 Tue 04:01:00 ===\n"
            f"=== {TAG} iter 1 end exit=0 dur=10s Tue 04:02:00 ===\n"
            f"=== {TAG} iter 2 Tue 04:03:00 ===\n"
            f"=== {TAG} iter 2 end exit=0 dur=12s Tue 04:05:00 ===\n"
        )
        check("2: normal anchors -> iter 2",
              parse_runner_iter(TAG, data2) == 2,
              f"got {parse_runner_iter(TAG, data2)!r}")

        # 3. mid-round: only a start anchor, no end yet -> current round (3).
        data3 = f"=== {TAG} iter 3 Tue 04:06:00 ===\npartial worker output...\n"
        check("3: mid-round start-only -> iter 3",
              parse_runner_iter(TAG, data3) == 3,
              f"got {parse_runner_iter(TAG, data3)!r}")

        # 4. no anchor at all (fresh LOOP start header only) -> None.
        data4 = f"=== {TAG} TEAM2-opus OBSERVABLE LOOP start Tue 04:00:00 ===\n"
        check("4: no anchor -> None",
              parse_runner_iter(TAG, data4) is None,
              f"got {parse_runner_iter(TAG, data4)!r}")

        # 5. a DIFFERENT tag's anchor must not be adopted -> own round only.
        data5 = (
            "=== othertag iter 9 Tue 03:00:00 ===\n"
            "=== othertag iter 9 end exit=0 dur=5s Tue 03:01:00 ===\n"
            f"=== {TAG} iter 1 Tue 04:01:00 ===\n"
        )
        check("5: foreign tag anchor ignored -> iter 1",
              parse_runner_iter(TAG, data5) == 1,
              f"got {parse_runner_iter(TAG, data5)!r}")
        check("5b: foreign tag seen as itself -> iter 9",
              parse_runner_iter("othertag", data5) == 9,
              f"got {parse_runner_iter('othertag', data5)!r}")

        # 6. end-to-end through task_info_v4 reading a real loop_<tag>.log.
        with open(os.path.join(SIGNAL_DIR, f"loop_{TAG}.log"), "w") as f:
            f.write(data1)
        ti = task_info_v4(TAG)
        check("6: task_info_v4 not None (running)", ti is not None,
              f"got {ti!r}")
        if ti is not None:
            check("6: task_info_v4 iter == 1 (not 6)", ti["iter"] == 1,
                  f"got iter={ti['iter']!r}")
            check("6b: last_line still readable", bool(ti["last"]),
                  f"last={ti['last']!r}")

        # 6c. a log with ONLY nested iter6 noise and NO own anchor -> None
        # (no round started for this tag yet).
        with open(os.path.join(SIGNAL_DIR, "loop_noanchor.log"), "w") as f:
            f.write("=== othertag iter 6 end exit=0 ===\nnoise iter 6\n")
        ti_na = task_info_v4("noanchor")
        check("6c: no own anchor -> task iter None",
              ti_na is not None and ti_na["iter"] is None,
              f"got {ti_na!r}")

        passed = sum(1 for _, c, _ in results if c)
        total = len(results)
        logmsg(f"ITER SELFTEST done: {passed}/{total} assertions passed")
        with open(LOG) as f:
            print("\n--- ITER SELFTEST waker.log ---")
            sys.stdout.write(f.read())
        if passed != total:
            print(f"\nFAIL: {total - passed} assertion(s) failed:")
            for name, cond, detail in results:
                if not cond:
                    print(f"  FAIL: {name} — {detail}")
            sys.exit(1)
        print(f"\nPASS: all {total} assertions passed")
    finally:
        pass


def run_heartbeat_selftest():
    """V5 secretary-heartbeat death-detection selftest (2026-07-30).

    Forged jsonl + temp STATE_DIR/DEATH_FILE; drives check_heartbeat + helpers
    with a controlled `now` and os.utime jsonl mtimes (NO real 90s/15min waits —
    all time comparisons use the `now` arg vs persisted probe_ts, never wall
    clock). NEVER touches the real ~/codex_work/SECRETARY_DOWN.
      1. busy-false-alarm  — recent jsonl activity -> no probe, no death
      2. real-death        — 3 evidence (streak+stale+probe no-response) -> SECRETARY_DOWN
      3. limit-classify    — rate.limit / usage.limit / no-response grep on jsonl tail
      4. probe-alive      — probe -> jsonl advances a little -> alive, streak reset
      5. auto-clear       — SECRETARY_DOWN present + fresh jsonl -> cleared
      6. streak-track     — _hb_track_after_inject increments/resets the streak"""
    global LOG, STATE_DIR, DEATH_FILE, LIVE, WAKE_TABTYPE
    import tempfile
    tmp = tempfile.mkdtemp(prefix="waker_hbtest_")
    LOG = os.path.join(tmp, "waker.log")
    STATE_DIR = os.path.join(tmp, ".waker")
    death_file = os.path.join(tmp, "SECRETARY_DOWN")
    DEATH_FILE = death_file
    os.makedirs(STATE_DIR, exist_ok=True)
    LIVE = True
    WAKE_TABTYPE = "claude"
    jsonl_path = os.path.join(tmp, "session.jsonl")
    with open(jsonl_path, "w") as f:
        f.write("")

    probe_calls = []
    ntfy_calls = []
    lark_calls = []

    def fake_latest_jsonl():
        return jsonl_path
    def fake_inject(msg, urgent=False):
        probe_calls.append((msg, urgent))
        return True
    def fake_ntfy(msg):
        ntfy_calls.append(msg)
    def fake_lark(text):
        lark_calls.append(text)

    g = globals()
    orig = {k: g[k] for k in ("latest_jsonl", "do_inject", "ntfy", "_lark_send",
            "DEATH_FILE", "STATE_DIR", "LIVE", "WAKE_TABTYPE", "LOG")}
    g["latest_jsonl"] = fake_latest_jsonl
    g["do_inject"] = fake_inject
    g["ntfy"] = fake_ntfy
    g["_lark_send"] = fake_lark

    results = []
    def check(name, cond, detail=""):
        results.append((name, cond, detail))
        logmsg(f"HB ASSERT {'PASS' if cond else 'FAIL'}: {name} {detail[:120]}")

    def set_mtime(t):
        os.utime(jsonl_path, (t, t))

    def write_jsonl(s):
        with open(jsonl_path, "w") as f:
            f.write(s)

    def clear_hb_state():
        for k in ("hb_no_consume_streak", "hb_last_inj_mtime", "hb_last_inj_ts",
                  "hb_probe", "hb_probe_mtime", "hb_last_death_alert"):
            try:
                os.remove(_state_file(k))
            except OSError:
                pass

    def death_text():
        try:
            with open(death_file) as f:
                return f.read()
        except OSError:
            return ""

    try:
        logmsg("HB SELFTEST start — V5 secretary heartbeat death detection")

        # --- 1. busy-false-alarm: recent activity -> no death ---
        clear_hb_state()
        probe_calls.clear(); ntfy_calls.clear(); lark_calls.clear()
        now = 100000.0
        set_mtime(now - 50)              # jsonl active 50s ago
        save_state("hb_no_consume_streak", "5")
        ret = check_heartbeat(now)
        check("1: busy returns False", ret is False, f"ret={ret!r}")
        check("1: no probe sent", len(probe_calls) == 0, f"probes={probe_calls}")
        check("1: no SECRETARY_DOWN", not os.path.exists(death_file))

        # --- 3. limit-classify (pure _death_cause on jp content) ---
        write_jsonl("...normal...\nassistant: Error: rate limit exceeded, retry later\n")
        check("3a: rate.limit classified", _death_cause(jsonl_path) == "rate.limit",
              f"got {_death_cause(jsonl_path)!r}")
        write_jsonl("...normal...\nassistant: usage limit reached for today\n")
        check("3b: usage.limit classified", _death_cause(jsonl_path) == "usage.limit",
              f"got {_death_cause(jsonl_path)!r}")
        write_jsonl("...normal...\nassistant: (no error, just stopped talking)\n")
        check("3c: no-response classified", _death_cause(jsonl_path) == "no-response",
              f"got {_death_cause(jsonl_path)!r}")

        # --- 2. real-death: 3 evidence -> SECRETARY_DOWN ---
        clear_hb_state()
        probe_calls.clear(); ntfy_calls.clear(); lark_calls.clear()
        write_jsonl("...normal...\nassistant: rate limit exceeded\n")  # sets the cause
        now0 = 1700000000.0             # epoch-scale so the alert cooldown math is real
        set_mtime(0.0)                  # jsonl stale since epoch -> very old
        save_state("hb_no_consume_streak", "3")     # condition (a)
        rA = check_heartbeat(now0)                    # beat A: send probe
        check("2A: probe beat returns True", rA is True, f"ret={rA!r}")
        check("2A: probe injected", len(probe_calls) == 1, f"probes={probe_calls}")
        check("2A: probe is heartbeat text", "心跳探针" in probe_calls[0][0])
        check("2A: probe urgent", probe_calls[0][1] is True)
        check("2A: no death yet", not os.path.exists(death_file))
        rB = check_heartbeat(now0 + 50)               # beat B: within probe wait
        check("2B: wait beat returns True", rB is True, f"ret={rB!r}")
        check("2B: still no death", not os.path.exists(death_file))
        check("2B: no second probe", len(probe_calls) == 1, f"probes={probe_calls}")
        rC = check_heartbeat(now0 + 100)              # beat C: past wait, no response
        check("2C: death beat returns True", rC is True, f"ret={rC!r}")
        check("2C: SECRETARY_DOWN written", os.path.exists(death_file))
        txt = death_text()
        check("2C: header present", txt.startswith("SECRETARY_DOWN"), f"txt={txt[:60]!r}")
        check("2C: cause rate.limit in file", "rate.limit" in txt)
        check("2C: evidence (a) present", "(a)" in txt and " 3 " in txt)
        check("2C: evidence (b) present", "(b)" in txt)
        check("2C: evidence (c) present", "(c)" in txt)
        check("2C: lark alerted", len(lark_calls) == 1, f"lark={lark_calls}")
        check("2C: ntfy alerted", len(ntfy_calls) == 1, f"ntfy={ntfy_calls}")

        # --- 2D. throttle: re-declare within cooldown -> no new alert ---
        ntfy_calls.clear(); lark_calls.clear()
        check_heartbeat(now0 + 1000)    # still stale + streak -> re-declares
        check("2D: throttle -> no second lark", len(lark_calls) == 0, f"lark={lark_calls}")
        check("2D: throttle -> no second ntfy", len(ntfy_calls) == 0, f"ntfy={ntfy_calls}")
        check("2D: file still present (rewritten)", os.path.exists(death_file))

        # --- 4. probe-alive: probe -> jsonl advances a little -> alive ---
        clear_hb_state()
        probe_calls.clear(); ntfy_calls.clear(); lark_calls.clear()
        if os.path.exists(death_file):
            os.remove(death_file)
        write_jsonl("...normal...\n")
        nowp = 2000.0
        set_mtime(0.0)                  # stale
        save_state("hb_no_consume_streak", "3")
        check_heartbeat(nowp)                         # probe sent
        check("4A: probe sent", len(probe_calls) == 1, f"probes={probe_calls}")
        set_mtime(60.0)                # secretary responds, but still stale (now-60 >= 900)
        r = check_heartbeat(nowp + 100)               # past probe wait, mtime advanced
        check("4B: alive beat returns True", r is True, f"ret={r!r}")
        check("4B: no SECRETARY_DOWN", not os.path.exists(death_file))
        check("4B: streak reset to 0",
              load_state("hb_no_consume_streak", "?") == "0",
              f"streak={load_state('hb_no_consume_streak','?')!r}")
        check("4B: probe cleared",
              load_state("hb_probe", "?") == "0",
              f"probe={load_state('hb_probe','?')!r}")

        # --- 5. auto-clear: SECRETARY_DOWN present + fresh jsonl -> cleared ---
        clear_hb_state()
        probe_calls.clear(); ntfy_calls.clear(); lark_calls.clear()
        with open(death_file, "w") as f:
            f.write("SECRETARY_DOWN\nstale leftover\n")
        nowc = 3000.0
        set_mtime(nowc - 60)            # fresh (< HB_RESUME_SEC=300)
        r = check_heartbeat(nowc)
        check("5: auto-clear returns False", r is False, f"ret={r!r}")
        check("5: SECRETARY_DOWN removed", not os.path.exists(death_file))
        check("5: resume ntfy sent", any("恢复" in m for m in ntfy_calls),
              f"ntfy={ntfy_calls}")

        # --- 6. streak-track: _hb_track_after_inject increments/resets ---
        clear_hb_state()
        write_jsonl("...normal...\n")
        set_mtime(500.0)
        _hb_track_after_inject(510.0)                 # first inject (no last_inj)
        check("6A: first inject streak 0",
              load_state("hb_no_consume_streak", "?") == "0",
              f"streak={load_state('hb_no_consume_streak','?')!r}")
        _hb_track_after_inject(520.0)                 # mtime unchanged -> +1
        check("6B: no-advance streak 1",
              load_state("hb_no_consume_streak", "?") == "1",
              f"streak={load_state('hb_no_consume_streak','?')!r}")
        _hb_track_after_inject(530.0)                 # still unchanged -> +1
        check("6C: no-advance streak 2",
              load_state("hb_no_consume_streak", "?") == "2",
              f"streak={load_state('hb_no_consume_streak','?')!r}")
        set_mtime(540.0)               # jsonl advances -> reset
        _hb_track_after_inject(550.0)
        check("6D: advance streak reset 0",
              load_state("hb_no_consume_streak", "?") == "0",
              f"streak={load_state('hb_no_consume_streak','?')!r}")

        passed = sum(1 for _, c, _ in results if c)
        total = len(results)
        logmsg(f"HB SELFTEST done: {passed}/{total} assertions passed")
        with open(LOG) as f:
            print("\n--- HB SELFTEST waker.log ---")
            sys.stdout.write(f.read())
        if passed != total:
            print(f"\nFAIL: {total - passed} assertion(s) failed:")
            for name, cond, detail in results:
                if not cond:
                    print(f"  FAIL: {name} — {detail}")
            sys.exit(1)
        print(f"\nPASS: all {total} assertions passed")
    finally:
        for k, v in orig.items():
            g[k] = v
        try:
            os.remove(jsonl_path)
        except OSError:
            pass


def run_diff_selftest():
    """V5 lightweight per-task diff snapshot selftest (2026-07-30).

    Forged temp git repo + temp STATE_DIR; exercises diff_fingerprint,
    compute_diff_state (cache reuse -> no reread of unchanged code), new_commits,
    non-git -> None, and build_diff_block output format."""
    global LOG, STATE_DIR
    import tempfile
    tmp = tempfile.mkdtemp(prefix="waker_difftest_")
    LOG = os.path.join(tmp, "waker.log")
    STATE_DIR = os.path.join(tmp, ".waker")
    os.makedirs(STATE_DIR, exist_ok=True)
    repo = os.path.join(tmp, "repo")
    os.makedirs(repo)

    results = []
    def check(name, cond, detail=""):
        results.append((name, cond, detail))
        logmsg(f"DIFF ASSERT {'PASS' if cond else 'FAIL'}: {name} {detail[:120]}")

    def git(args, cwd=repo):
        r = subprocess.run(["git", "-C", cwd] + args, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True)
        return r.returncode, r.stdout, r.stderr

    def clear_diff_state():
        for fn in os.listdir(STATE_DIR):
            os.remove(os.path.join(STATE_DIR, fn))

    try:
        logmsg("DIFF SELFTEST start — V5 lightweight diff snapshot")
        git(["init", "-q"])
        git(["config", "user.email", "t@t"])
        git(["config", "user.name", "t"])
        with open(os.path.join(repo, "a.txt"), "w") as f:
            f.write("hello\n")
        git(["add", "-A"]); git(["commit", "-q", "-m", "c1"])

        # 1. diff_fingerprint on a clean repo -> fp str, changed=[]
        fp1, ch1 = diff_fingerprint(repo)
        check("1: clean fp is 40-hex str", isinstance(fp1, str) and len(fp1) == 40,
              f"fp={fp1!r}")
        check("1: clean changed empty", ch1 == [], f"changed={ch1!r}")

        # 2. edit working tree -> fp changes, changed has the file
        with open(os.path.join(repo, "a.txt"), "w") as f:
            f.write("hello world\n")
        fp2, ch2 = diff_fingerprint(repo)
        check("2: fp changes on edit", fp2 != fp1, f"{fp1!r} vs {fp2!r}")
        check("2: changed has a.txt", "a.txt" in ch2, f"changed={ch2!r}")

        # 3. untracked file appears in changed
        with open(os.path.join(repo, "b.txt"), "w") as f:
            f.write("new\n")
        fp3, ch3 = diff_fingerprint(repo)
        check("3: untracked b.txt in changed", "b.txt" in ch3, f"changed={ch3!r}")
        check("3: fp changes again", fp3 != fp2, f"{fp2!r} vs {fp3!r}")

        # 4. compute_diff_state cache reuse -> no reread of unchanged code
        clear_diff_state()
        git(["add", "-A"]); git(["commit", "-q", "-m", "c2"])   # commit all -> clean
        st1 = compute_diff_state("T", repo)
        check("4a: first compute returns dict", st1 is not None and st1["tag"] == "T",
              f"st={st1!r}")
        check("4a: first compute reused=False",
              st1 is not None and st1["reused"] is False,
              f"reused={st1.get('reused') if st1 else None!r}")
        fp_cached = st1["fp"] if st1 else None
        st2 = compute_diff_state("T", repo)                    # no change -> reused
        check("4b: unchanged reused=True",
              st2 is not None and st2["reused"] is True,
              f"reused={st2.get('reused') if st2 else None!r}")
        check("4b: unchanged same fp", st2 is not None and st2["fp"] == fp_cached,
              f"{fp_cached!r} vs {st2.get('fp') if st2 else None!r}")
        check("4b: unchanged changed reused from cache",
              st2 is not None and st2["changed"] == (st1["changed"] if st1 else None))

        # 5. new commit -> fp changes, commits populated (<=5)
        with open(os.path.join(repo, "a.txt"), "w") as f:
            f.write("hello again\n")
        git(["add", "-A"]); git(["commit", "-q", "-m", "c3"])
        st3 = compute_diff_state("T", repo)
        check("5: changed-after-commit reused=False",
              st3 is not None and st3["reused"] is False,
              f"reused={st3.get('reused') if st3 else None!r}")
        check("5: new commits found",
              st3 is not None and len(st3["commits"]) >= 1,
              f"commits={st3.get('commits') if st3 else None!r}")
        check("5: new commit msg c3",
              st3 is not None and any("c3" in c for c in st3["commits"]),
              f"commits={st3.get('commits') if st3 else None!r}")

        # 6. non-git / missing dir -> None
        nongit = os.path.join(tmp, "nongit")
        os.makedirs(nongit)
        check("6: non-git fingerprint (None, [])", diff_fingerprint(nongit) == (None, []))
        check("6: non-git compute None", compute_diff_state("T2", nongit) is None)
        check("6: missing dir compute None",
              compute_diff_state("T3", os.path.join(tmp, "nope")) is None)

        # 7. build_diff_block output format
        running = [{"tag": "T"}, {"tag": "T2"}]
        block = build_diff_block(running, [st3, None])          # T2 None -> filtered
        check("7: block not None", block is not None)
        check("7: header diff快照(1)", block is not None and "diff快照(1):" in block,
              f"block={block[:80]!r}")
        check("7: T line has fp=", block is not None and "T: fp=" in block)
        check("7: footer hint present", block is not None and "派工前请先看活态" in block)
        check("7b: all-None -> None block",
              build_diff_block(running, [None, None]) is None)

        passed = sum(1 for _, c, _ in results if c)
        total = len(results)
        logmsg(f"DIFF SELFTEST done: {passed}/{total} assertions passed")
        with open(LOG) as f:
            print("\n--- DIFF SELFTEST waker.log ---")
            sys.stdout.write(f.read())
        if passed != total:
            print(f"\nFAIL: {total - passed} assertion(s) failed:")
            for name, cond, detail in results:
                if not cond:
                    print(f"  FAIL: {name} — {detail}")
            sys.exit(1)
        print(f"\nPASS: all {total} assertions passed")
    finally:
        pass


def run_akari_selftest():
    """2026-07-31 史官纳管 akari job-level watch selftest (offline).

    Faked akari API JSON (lens/lanes + workers + asks) + temp STATE_DIR + temp
    AKARI_RUNS_ROOT. Exercises akari_jobs_lines (pure projection), akari_jobs_block
    (network wrapper + fault tolerance), and the log-tail / start-time / progress
    helpers. No real curl, no real akari server — _akari_get is patched to return
    scripted JSON or None."""
    global LOG, STATE_DIR, AKARI_RUNS_ROOT
    import tempfile
    tmp = tempfile.mkdtemp(prefix="waker_akaritest_")
    LOG = os.path.join(tmp, "waker.log")
    STATE_DIR = os.path.join(tmp, ".waker")
    runs_root = os.path.join(tmp, "akari_runs")
    os.makedirs(STATE_DIR, exist_ok=True)
    os.makedirs(runs_root, exist_ok=True)

    results = []
    def check(name, cond, detail=""):
        results.append((name, cond, detail))
        logmsg(f"AKARI ASSERT {'PASS' if cond else 'FAIL'}: {name} {detail[:120]}")

    # fake _akari_get returns scripted JSON per path, or None (akari down)
    fake_api = {}
    def fake_get(path, timeout=6):
        return fake_api.get(path)
    g = globals()
    orig = {k: g[k] for k in ("_akari_get", "AKARI_RUNS_ROOT", "STATE_DIR", "LOG")}
    g["_akari_get"] = fake_get
    AKARI_RUNS_ROOT = runs_root

    now_ts = 1722300000.0  # fixed epoch for stable start-time math

    try:
        logmsg("AKARI SELFTEST start — akari job-level watch (offline)")

        # --- 1. idle: no terminals, no running, no asks -> [] (no noise) ---
        fake_api.clear()
        fake_api["/api/lens/lanes"] = {"lanes": [], "recent_terminals": []}
        fake_api["/api/workers"] = {"workers": []}
        fake_api["/api/asks"] = {"asks": []}
        lens = fake_get("/api/lens/lanes")
        workers = fake_get("/api/workers")
        asks = fake_get("/api/asks")
        lines = akari_jobs_lines(lens, workers, asks, {}, now_ts)
        check("1: idle -> [] (no noise)", lines == [],
              f"got {lines!r}")

        # --- 2. running jobs -> "akari在跑(N):" with worker label/state/start ---
        fake_api.clear()
        fake_api["/api/lens/lanes"] = {
            "lanes": [{"id": "lane-0", "state": "busy", "run": "run-xyz"}],
            "recent_terminals": []}
        fake_api["/api/workers"] = {"workers": [
            {"label": "w-root", "worker_id": "w1", "state": "running",
             "elapsed_secs": 120, "last_reasoning": "analyzing the diff",
             "turn": 3},
            {"label": "w-fork", "worker_id": "w2", "state": "queued",
             "elapsed_secs": 30, "current_activity": "waiting for lane",
             "parent_worker_id": "w1"},
        ]}
        fake_api["/api/asks"] = {"asks": []}
        lens = fake_get("/api/lens/lanes")
        workers = fake_get("/api/workers")
        asks = fake_get("/api/asks")
        lines = akari_jobs_lines(lens, workers, asks, {}, now_ts)
        block = "\n".join(lines)
        check("2: running header present", "akari在跑(2):" in block, block)
        # root worker first (no parent), then fork
        check("2b: root worker first", lines.index("akari在跑(2):") + 1 < len(lines)
              and "w-root" in lines[lines.index("akari在跑(2):") + 1], block)
        check("2c: start HH:MM present", "|HH:MM" not in block, "placeholder absent")
        # start time: now_ts - 120s -> stable HH:MM
        expected_start = time.strftime("%H:%M", time.localtime(now_ts - 120))
        check("2d: start time correct", f"|{expected_start}" in block,
              f"expected |{expected_start} in {block!r}")
        check("2e: progress from last_reasoning", "analyzing the diff" in block, block)
        check("2f: queued state shown", "w-fork(queued" in block, block)
        check("2g: turn number shown", "|t3" in block, block)

        # --- 3. terminal success -> "akari终态(N):" with "成功(merged)" ---
        fake_api.clear()
        fake_api["/api/lens/lanes"] = {
            "lanes": [],
            "recent_terminals": [
                {"name": "run-merge-1", "outcome": "merged",
                 "completed_at": "2026-07-31T14:23:00Z", "run_id": "r1"},
            ]}
        fake_api["/api/workers"] = {"workers": []}
        fake_api["/api/asks"] = {"asks": []}
        lens = fake_get("/api/lens/lanes")
        lines = akari_jobs_lines(lens, {}, {}, {}, now_ts)
        block = "\n".join(lines)
        check("3: terminal header present", "akari终态(1):" in block, block)
        check("3b: success merged shown", "成功(merged)" in block, block)
        check("3c: completed time shown", "@14:23" in block, block)

        # --- 4. terminal failure -> "‼️" + "失败" + failure text ---
        fake_api.clear()
        fake_api["/api/lens/lanes"] = {
            "lanes": [],
            "recent_terminals": [
                {"name": "run-fail-1", "outcome": "failed",
                 "failure": "exit code 1 from test suite",
                 "completed_at": "2026-07-31T15:00:00Z", "run_id": "r2"},
            ]}
        lens = fake_get("/api/lens/lanes")
        lines = akari_jobs_lines(lens, {}, {}, {}, now_ts)
        block = "\n".join(lines)
        check("4: failure shown", "‼️" in block and "失败" in block, block)
        check("4b: failure text included", "exit code 1" in block, block)

        # --- 5. terminal failure with manifest -> log tail from manifest ---
        manifest_dir = os.path.join(runs_root, "r3")
        os.makedirs(manifest_dir)
        with open(os.path.join(manifest_dir, "manifest.json"), "w") as f:
            json.dump({"terminal_reasons": [
                "test suite failed: 3 assertions",
                "build error in module foo",
                "timeout waiting for response",
            ]}, f)
        fake_api.clear()
        fake_api["/api/lens/lanes"] = {
            "lanes": [],
            "recent_terminals": [
                {"name": "run-fail-2", "outcome": "failed",
                 "failure": "truncated first reason",
                 "completed_at": "2026-07-31T16:00:00Z", "run_id": "r3"},
            ]}
        lens = fake_get("/api/lens/lanes")
        lines = akari_jobs_lines(lens, {}, {}, {}, now_ts)
        block = "\n".join(lines)
        check("5: manifest log tail used (not API failure)",
              "test suite failed" in block and "truncated first reason" not in block,
              block)
        check("5b: top-3 reasons joined", "build error" in block, block)

        # --- 6. pending asks -> "akari待批复(N):" ---
        fake_api.clear()
        fake_api["/api/lens/lanes"] = {"lanes": [], "recent_terminals": []}
        fake_api["/api/workers"] = {"workers": []}
        fake_api["/api/asks"] = {"asks": [
            {"ask_id": "ask-1", "question": "Should I proceed with plan A or B?", "age_secs": 45},
        ]}
        lens = fake_get("/api/lens/lanes")
        workers = fake_get("/api/workers")
        asks = fake_get("/api/asks")
        lines = akari_jobs_lines(lens, workers, asks, {}, now_ts)
        block = "\n".join(lines)
        check("6: pending asks header", "akari待批复(1):" in block, block)
        check("6b: ask question shown", "Should I proceed" in block, block)

        # --- 7. lane diff with real temp repo -> "lane-diff" lines ---
        repo = os.path.join(tmp, "lane_repo")
        os.makedirs(repo)
        subprocess.run(["git", "-C", repo, "init", "-q"], check=True)
        subprocess.run(["git", "-C", repo, "config", "user.email", "t@t"], check=True)
        subprocess.run(["git", "-C", repo, "config", "user.name", "t"], check=True)
        with open(os.path.join(repo, "a.txt"), "w") as f:
            f.write("hello\n")
        subprocess.run(["git", "-C", repo, "add", "-A"], check=True)
        subprocess.run(["git", "-C", repo, "commit", "-q", "-m", "c1"], check=True)
        with open(os.path.join(repo, "a.txt"), "w") as f:
            f.write("hello world\n")  # working-tree change
        fake_api.clear()
        fake_api["/api/lens/lanes"] = {
            "lanes": [{"id": "lane-0", "state": "busy", "run": "run-diff"}],
            "recent_terminals": []}
        fake_api["/api/workers"] = {"workers": []}
        fake_api["/api/asks"] = {"asks": []}
        fake_api["/api/lanes"] = {"lanes": [
            {"id": "lane-0", "checkout_path": repo, "at_main": False,
             "head_short": "abc1234", "occupant": "run-diff"},
        ]}
        lens = fake_get("/api/lens/lanes")
        workers = fake_get("/api/workers")
        asks = fake_get("/api/asks")
        lanes = fake_get("/api/lanes")
        lines = akari_jobs_lines(lens, workers, asks, lanes, now_ts)
        block = "\n".join(lines)
        check("7: lane-diff header present", "akari lane-diff(1):" in block, block)
        check("7b: fingerprint shown", "fp=" in block, block)
        check("7c: changed file count", "改" in block and "文件" in block, block)

        # --- 8. akari down (_akari_get=None) -> akari_jobs_block returns "" ---
        fake_api.clear()  # all paths return None -> akari down
        block = akari_jobs_block()
        check("8: akari down -> '' (fault tolerant)", block == "", repr(block))

        # --- 9. akari_jobs_block end-to-end with live faked API ---
        fake_api.clear()
        fake_api["/api/lens/lanes"] = {
            "lanes": [{"id": "lane-0", "state": "busy", "run": "r-live"}],
            "recent_terminals": [
                {"name": "run-prev", "outcome": "merged",
                 "completed_at": "2026-07-31T10:00:00Z", "run_id": "rp"},
            ]}
        fake_api["/api/workers"] = {"workers": [
            {"label": "w-live", "worker_id": "w1", "state": "running",
             "elapsed_secs": 300, "last_tool": "edit_file"},
        ]}
        fake_api["/api/asks"] = {"asks": []}
        # no /api/lanes -> busy lane but no checkout_path -> no diff (None is fine)
        block = akari_jobs_block()
        check("9: block has terminal section", "akari终态(1):" in block, block)
        check("9b: block has running section", "akari在跑(1):" in block, block)
        check("9c: block has last_tool progress", "edit_file" in block, block)

        # --- 10. helper unit tests ---
        # _akari_start_hhmm: stable across beats (both now and elapsed advance)
        s1 = _akari_start_hhmm(120, 1722300120.0)
        s2 = _akari_start_hhmm(120, 1722300120.0)  # same -> same (idempotent)
        check("10: start time idempotent", s1 == s2 and bool(re.match(r'^\d{2}:\d{2}$', s1)),
              f"got {s1!r}")
        check("10b: start time None on bad elapsed", _akari_start_hhmm(None, 0.0) == "", "")
        check("10c: start time '' on negative", _akari_start_hhmm(-5, 0.0) == "", "")
        # _akari_progress: prefers last_reasoning, then current_activity, then last_tool
        check("10d: progress last_reasoning",
              _akari_progress({"last_reasoning": "LR"}) == "LR", "")
        check("10e: progress current_activity fallback",
              _akari_progress({"current_activity": "CA"}) == "CA", "")
        check("10f: progress last_tool fallback",
              _akari_progress({"last_tool": "LT"}) == "LT", "")
        check("10g: progress empty when none",
              _akari_progress({}) == "", "")
        check("10h: progress truncation",
              _akari_progress({"last_reasoning": "x" * 100}).endswith("…"), "")
        # _akari_term_log_tail: falls back to API failure when manifest absent
        check("10i: log tail fallback to API failure",
              _akari_term_log_tail("nonexistent_run", "api fail") == "api fail", "")
        check("10j: log tail empty when no failure and no manifest",
              _akari_term_log_tail("nonexistent_run", "") == "", "")

        # --- summary ---
        total = len(results)
        npass = sum(1 for _, c, _ in results if c)
        logmsg(f"AKARI SELFTEST: {npass}/{total} assertions passed")
        for name, cond, detail in results:
            if not cond:
                print(f"  FAIL: {name} — {detail}")
        if npass != total:
            sys.exit(1)
        print(f"\nPASS: all {total} assertions passed")
    finally:
        for k, v in orig.items():
            g[k] = v


# ---------------- main ----------------

def _beat_alarm(signum, frame):
    raise TimeoutError(f"beat exceeded BEAT_TIMEOUT={BEAT_TIMEOUT}s")


def run_beat():
    """Run one beat under a hard wall-clock alarm. SIGALRM interrupts any
    blocking select/read/write (e.g. a tmux/curl subprocess whose child holds
    a pipe open past its timeout) so the waker can never hang on a single
    beat — the exception is caught by the main loop and the next tick proceeds."""
    signal.alarm(BEAT_TIMEOUT)
    try:
        beat()
    finally:
        signal.alarm(0)


def main():
    global LIVE, MODE
    os.makedirs(STATE_DIR, exist_ok=True)
    if "--selftest" in sys.argv:
        run_selftest()
        return
    if "--selftest-gap" in sys.argv:
        run_gap_selftest()
        return
    if "--selftest-iter" in sys.argv:
        run_iter_selftest()
        return
    if "--selftest-heartbeat" in sys.argv:
        run_heartbeat_selftest()
        return
    if "--selftest-diff" in sys.argv:
        run_diff_selftest()
        return
    if "--selftest-akari" in sys.argv:
        run_akari_selftest()
        return
    if "--brief" in sys.argv:
        running = running_tasks()
        write_army_status(running)
        # V4.4 待批复: --brief projects one beat so the diagnostic shows the
        # section the master would actually see (beats = persisted+1).
        cur_pending = scan_pending_approvals()
        prev_pending = load_pending_state()
        pending_display = {}
        for tag, line in cur_pending.items():
            beats = prev_pending.get(tag, {}).get("beats", 0) + 1
            pending_display[tag] = {"beats": beats, "line": line}
        diff_states = [compute_diff_state(t["tag"], t.get("workdir"))
                       for t in running if t.get("workdir")]
        diff_block = build_diff_block(running, diff_states)
        akari_block = akari_jobs_block()
        msg = build_briefing(set(), stalled_set(running), running,
                             load_stats().get("beat", 0), load_stats(),
                             load_task_snapshot(), pending_display,
                             diff_block=diff_block, akari_block=akari_block)
        print(msg)
        return
    if "--coverage" in sys.argv:
        running = running_tasks()
        write_army_status(running)
        cov = load_coverage()
        print(f"coverage (persisted, {len(cov)}): {sorted(cov)}")
        print(f"running ({len(running)}):")
        for t in sorted(running, key=lambda x: x["age"]):
            print(f"  {t['tag']} age={t['age']/60:.0f}min iter={t['iter']} "
                  f"spin={t['spin']} …{t['last']}")
        return
    # auto_live persisted from a prior 3-dry phase makes a crontab respawn
    # or --once start LIVE without WAKE_LIVE.
    if int(load_state("auto_live", "0")):
        LIVE = True
        MODE = "live"
    # V4 supplement: single-instance lock (flock). Prevents the double-open
    # accident (20:10) where two waker_core instances each inject a duplicate
    # briefing. Non-blocking: if another instance holds the lock, exit 0.
    # --selftest/--brief/--coverage are read-only diagnostics, no lock needed.
    # 自锚①：主机守卫——不在指定主机绝不值守（flock 只锁本机，锁不住跨机野史官；
    # 2026-07-18 ai-03 野史官空转 2.5h 事故的根治）。
    if EXPECTED_HOST and SELF_HOST != EXPECTED_HOST:
        logmsg(f"‼️ HOST-GUARD: {ANCHOR} 但指定值守主机={EXPECTED_HOST} — 拒绝启动")
        ntfy(f"‼️史官HOST-GUARD拒启: 有人在 {SELF_HOST} 起史官(应在 {EXPECTED_HOST})")
        sys.exit(1)
    lock_path = os.path.join(STATE_DIR, "singleton.lock")
    _lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(_lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (BlockingIOError, OSError):
        logmsg(f"SINGLETON-LOCK held by another waker_core instance — "
               f"exiting (pid={os.getpid()})")
        sys.exit(0)
    signal.signal(signal.SIGALRM, _beat_alarm)   # hard per-beat timeout (anti-hang)
    if "--once" in sys.argv:
        run_beat()
        return
    logmsg(f"waker_core V6 节拍制(20min基拍+3min退避) started mode={MODE} "
           f"check={CHECK_INTERVAL}s brief={BRIEF_INTERVAL}s busy={BUSY_SEC}s "
           f"conv={CONV_SEC}s retry={RETRY_SEC}s stream={STREAMING_SEC}s "
           f"gap={MIN_GAP}s cap={HOURLY_CAP}/hr stall={STALL_MIN}s "
           f"run_age={RUN_MAX_AGE}s survival={SURVIVAL_INTERVAL}s "
           f"auto_live={int(LIVE)} pid={os.getpid()} "
           f"jsonl_dir={JSONL_DIR}")
    while True:
        try:
            run_beat()
        except Exception as e:
            logmsg(f"BEAT EXC {e!r}\n{traceback.format_exc()}")
        time.sleep(sleep_interval())


if __name__ == "__main__":
    main()
