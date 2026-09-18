#!/usr/bin/env python3
"""board_plan.py — board_upsert.sh 的纯决策芯 (owner 2026-09-14 直令 / MES-15907)。

职责边界 (荣耻篇 §二 壳是壳芯是芯): 本文件不碰网络、不调 lark-cli、不写盘。
stdin 收 `lark-cli base +record-list --format json` 的原样回包, stdout 出一条指令,
由 board_upsert.sh 执行真实写入。因此可以拿一份存档 JSON 直接单测, 不必起 lark。

stdout 指令 (制表符分隔, 首行决定动作):
  ERR   <人读原因>                 解析/校验失败, 调用方 rc=4
  MISS  <tag>                      板上无该 TAG 行
  HIT   <record_id>                --get 命中, 后续 FIELD 行给现值
  DUMP  <行数>                     --dump, 后续 ROW 行给 "<tag>\t<状态>"
  SKIP  <原因>                     幂等: 无字段需要变更
  WRITE <{"record_id":..,"fields":{..}}>   需要真正写入

环境入参: BM_TAG BM_TAGFIELD BM_MODE BM_KEEP BM_NOCREATE BM_ARGSFILE
"""

import json
import os
import sys


def emit(kind, payload=""):
    print(kind + "\t" + payload)


def cell_text(v):
    """lark CellValue -> 可比对纯文本。未知形状退化成 str(), 绝不吞掉内容。"""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, (bool, int, float)):
        return str(v)
    if isinstance(v, list):
        out = []
        for it in v:
            if isinstance(it, dict):
                out.append(it.get("text") or it.get("name") or it.get("id") or "")
            else:
                out.append(str(it))
        return ",".join(x for x in out if x)
    if isinstance(v, dict):
        return v.get("text") or v.get("name") or v.get("id") or ""
    return str(v)


def parse_arg(a):
    """'FIELD=VAL' -> (FIELD, VAL, False); 'FIELD+=VAL' -> (FIELD, VAL, True)。

    按第一个 '=' 切分; 左侧以 '+' 结尾即追加模式。值里含 '=' 不受影响。
    """
    if "=" not in a:
        return None
    name, _, val = a.partition("=")
    if name.endswith("+"):
        return name[:-1].strip(), val, True
    return name.strip(), val, False


def main():
    tag = os.environ["BM_TAG"]
    tag_field = os.environ["BM_TAGFIELD"]
    mode = os.environ["BM_MODE"]
    keep = int(os.environ["BM_KEEP"])
    nocreate = os.environ["BM_NOCREATE"] == "1"
    args_file = os.environ.get("BM_ARGSFILE", "")

    raw_args = []
    if args_file and os.path.exists(args_file):
        with open(args_file, encoding="utf-8") as fh:
            raw_args = [line.rstrip("\n") for line in fh if line.strip()]

    try:
        doc = json.load(sys.stdin)
    except ValueError as exc:
        emit("ERR", "record-list 回包不是 JSON: %s" % exc)
        return
    if not doc.get("ok"):
        emit("ERR", "lark record-list ok=false: %s"
             % json.dumps(doc.get("error"), ensure_ascii=False))
        return

    d = doc.get("data") or {}
    names = d.get("fields") or []
    types = d.get("field_type_list") or []
    rec_ids = d.get("record_id_list") or []
    matrix = d.get("data") or []
    if not names:
        emit("ERR", "record-list 未回 fields 列名, 形状不认识: %s"
             % ",".join(sorted(d.keys())))
        return
    type_of = dict(zip(names, types))

    if tag_field not in names:
        emit("ERR", "板上没有 join key 列 %s — 需先 +field-create 建机器列 "
                    "(缺 bot 写权限时见 NEEDSIG_boardmech)" % tag_field)
        return
    ti = names.index(tag_field)

    if mode == "dump":
        # 旗哨用: 一次读板拿到全部 TAG 的现状态, 只对有变化的 TAG 再发写
        state_field = os.environ.get("BM_STATEFIELD", "")
        si = names.index(state_field) if state_field in names else -1
        rows_out = []
        for i, row in enumerate(matrix):
            t = cell_text(row[ti] if ti < len(row) else None)
            if not t:
                continue
            st = cell_text(row[si] if 0 <= si < len(row) else None)
            rows_out.append(t + "\t" + st)
        emit("DUMP", str(len(rows_out)))
        for r in rows_out:
            emit("ROW", r)
        return

    # 按 join key 精确相等命中, 绝不子串猜行 (荣耻篇 §七 启发式不冒充输入)
    hits = [i for i, row in enumerate(matrix)
            if i < len(rec_ids)
            and cell_text(row[ti] if ti < len(row) else None) == tag]
    if len(hits) > 1:
        emit("ERR", "板上有 %d 行 %s=%s, 歧义拒写 (人工去重后重试)"
             % (len(hits), tag_field, tag))
        return

    cur, rec_id = {}, ""
    if hits:
        i = hits[0]
        rec_id = rec_ids[i]
        row = matrix[i]
        for j, nm in enumerate(names):
            cur[nm] = cell_text(row[j] if j < len(row) else None)

    if mode == "get":
        if not hits:
            emit("MISS", tag)
            return
        emit("HIT", rec_id)
        for nm in names:
            if cur.get(nm):
                emit("FIELD", nm + "=" + cur[nm].replace("\n", "\\n"))
        return

    payload, skipped = {}, []
    for a in raw_args:
        parsed = parse_arg(a)
        if parsed is None:
            emit("ERR", "参数 %r 不是 FIELD=VALUE 或 FIELD+=VALUE" % a)
            return
        name, val, append = parsed
        if name not in names:
            emit("ERR", "板上没有列 %s (机器列未建全? 见 NEEDSIG_boardmech)" % name)
            return
        old = cur.get(name, "")
        if append:
            lines = [l for l in old.split("\n") if l != ""]
            if lines and lines[-1] == val:
                skipped.append(name + "(末行同值)")
                continue
            lines.append(val)
            payload[name] = "\n".join(lines[-keep:])
        else:
            if old == val:
                skipped.append(name + "(同值)")
                continue
            payload[name] = val

    if not payload:
        emit("SKIP", "幂等跳过: " + (", ".join(skipped) if skipped else "无字段变更"))
        return

    if not hits:
        if nocreate:
            emit("MISS", tag)
            return
        payload[tag_field] = tag

    # 单选列的 CellValue 形状必须是 ["选项"]
    for nm, v in list(payload.items()):
        if type_of.get(nm) == "select" and not isinstance(v, list):
            payload[nm] = [v]

    emit("WRITE", json.dumps({"record_id": rec_id, "fields": payload},
                             ensure_ascii=False))
    if skipped:
        emit("NOTE", "同时幂等跳过: " + ", ".join(skipped))


if __name__ == "__main__":
    main()
