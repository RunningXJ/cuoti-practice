# -*- coding: utf-8 -*-
"""错题练习一键启动服务：手机同网可访问。"""
from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
STATIC = ROOT / "static"
QUESTIONS = DATA / "questions.json"
STATE = DATA / "user_state.json"
STATE_BAK = DATA / "user_state.bak.json"
PORT = int(os.environ.get("PORT") or os.environ.get("EXAM_PORT", "8765"))

DEFAULT_STATE = {
    "choppedIds": [],
    "choppedMeta": {},
    "practiceWrongs": {},
    "stats": {
        "answered": 0,
        "correct": 0,
        "wrong": 0,
        "chopped": 0,
    },
    "history": [],
    "progressByMode": {},
}


def ensure_state():
    """保证状态文件存在；已有数据永不覆盖，只补齐缺失字段。"""
    DATA.mkdir(parents=True, exist_ok=True)
    if not STATE.exists():
        if STATE_BAK.exists():
            try:
                data = json.loads(STATE_BAK.read_text(encoding="utf-8"))
                write_json(STATE, merge_state(DEFAULT_STATE, data))
                return
            except Exception:
                pass
        write_json(STATE, DEFAULT_STATE)
        return
    try:
        data = read_json(STATE)
        merged = merge_state(DEFAULT_STATE, data)
        if merged != data:
            write_json(STATE, merged)
    except Exception:
        # 主文件损坏时尝试备份恢复
        if STATE_BAK.exists():
            try:
                data = json.loads(STATE_BAK.read_text(encoding="utf-8"))
                write_json(STATE, merge_state(DEFAULT_STATE, data))
                return
            except Exception:
                pass
        # 最后才重建空状态，并尽量保留坏文件
        broken = DATA / f"user_state.broken.{int(time.time())}.json"
        try:
            STATE.replace(broken)
        except Exception:
            pass
        write_json(STATE, DEFAULT_STATE)


def merge_state(default: dict, current: dict) -> dict:
    out = dict(default)
    if not isinstance(current, dict):
        return out
    for k, v in current.items():
        if k == "stats" and isinstance(v, dict):
            base = dict(default.get("stats") or {})
            base.update(v)
            out["stats"] = base
        else:
            out[k] = v
    # 确保关键容器类型正确
    for key in ("choppedIds", "history"):
        if not isinstance(out.get(key), list):
            out[key] = []
    for key in ("choppedMeta", "practiceWrongs", "progressByMode", "stats"):
        if not isinstance(out.get(key), dict):
            out[key] = dict(default.get(key) or {})
    return out


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, obj):
    """原子写入，并同步备份，避免关服务时写到一半丢数据。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, indent=2)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
    if path.resolve() == STATE.resolve():
        try:
            STATE_BAK.write_text(text, encoding="utf-8")
        except Exception:
            pass


def local_ips():
    ips = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip not in ips:
            ips.insert(0, ip)
    except Exception:
        pass
    return ips


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def log_message(self, fmt, *args):
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        raw = self.rfile.read(n)
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/bank":
            bank = read_json(QUESTIONS)
            state = read_json(STATE)
            chopped = set(state.get("choppedIds") or [])
            qs = [q for q in bank.get("questions", []) if q.get("id") not in chopped]
            self._send_json(
                200,
                {
                    "examName": bank.get("examName"),
                    "updatedAt": bank.get("updatedAt"),
                    "sourceAttempts": bank.get("sourceAttempts"),
                    "totalInBank": bank.get("total"),
                    "activeTotal": len(qs),
                    "choppedTotal": len(chopped),
                    "questions": qs,
                    "state": {
                        "stats": state.get("stats", {}),
                        "practiceWrongs": state.get("practiceWrongs", {}),
                        "choppedIds": list(chopped),
                        "choppedMeta": state.get("choppedMeta", {}),
                        "progressByMode": state.get("progressByMode", {}),
                    },
                },
            )
            return
        if path == "/api/state":
            self._send_json(200, read_json(STATE))
            return
        if path in ("/", ""):
            self.path = "/index.html"
        return SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        path = urlparse(self.path).path
        data = self._read_body()
        state = read_json(STATE)
        chopped = set(state.get("choppedIds") or [])
        practice = state.setdefault("practiceWrongs", {})
        stats = state.setdefault(
            "stats", {"answered": 0, "correct": 0, "wrong": 0, "chopped": 0}
        )
        history = state.setdefault("history", [])

        if path == "/api/answer":
            qid = data.get("id")
            correct = bool(data.get("correct"))
            selected = data.get("selected") or []
            stats["answered"] = int(stats.get("answered") or 0) + 1
            if correct:
                stats["correct"] = int(stats.get("correct") or 0) + 1
                # 答对不清除错误次数，只标记最近一次正确（统计长期保留）
                if qid in practice:
                    practice[qid]["lastCorrect"] = True
                    practice[qid]["lastCorrectAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
            else:
                stats["wrong"] = int(stats.get("wrong") or 0) + 1
                item = practice.get(qid) or {
                    "count": 0,
                    "selectedHistory": [],
                    "lastCorrect": False,
                }
                item["count"] = int(item.get("count") or 0) + 1
                item["lastCorrect"] = False
                hist = item.setdefault("selectedHistory", [])
                hist.append({"at": time.strftime("%Y-%m-%d %H:%M:%S"), "selected": selected})
                item["selectedHistory"] = hist[-20:]
                practice[qid] = item
            history.append(
                {
                    "at": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "id": qid,
                    "correct": correct,
                    "selected": selected,
                }
            )
            state["history"] = history[-500:]
            write_json(STATE, state)
            self._send_json(200, {"ok": True, "stats": stats, "practiceWrongs": practice})
            return

        if path == "/api/chop":
            qid = data.get("id")
            if not qid:
                self._send_json(400, {"ok": False, "error": "missing id"})
                return
            if qid not in chopped:
                chopped.add(qid)
                stats["chopped"] = int(stats.get("chopped") or 0) + 1
            meta = state.setdefault("choppedMeta", {})
            meta[qid] = {
                "stem": data.get("stem") or meta.get(qid, {}).get("stem") or "",
                "type": data.get("type") or meta.get(qid, {}).get("type") or "",
                "answer": data.get("answer") or meta.get(qid, {}).get("answer") or "",
                "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            }
            practice.pop(qid, None)
            # remove from all mode progress queues
            progress = state.setdefault("progressByMode", {})
            for mode, item in list(progress.items()):
                ids = [x for x in (item.get("queueIds") or []) if x != qid]
                if not ids:
                    progress.pop(mode, None)
                    continue
                item["queueIds"] = ids
                if int(item.get("index") or 0) >= len(ids):
                    item["index"] = max(0, len(ids) - 1)
                sess = item.get("session") or {}
                sess["total"] = len(ids)
                if isinstance(sess.get("wrongIds"), list):
                    sess["wrongIds"] = [x for x in sess["wrongIds"] if x != qid]
                item["session"] = sess
            state["choppedIds"] = sorted(chopped)
            write_json(STATE, state)
            self._send_json(
                200,
                {
                    "ok": True,
                    "choppedIds": state["choppedIds"],
                    "choppedMeta": meta,
                    "stats": stats,
                },
            )
            return

        if path == "/api/unchop":
            qid = data.get("id")
            chopped.discard(qid)
            state.get("choppedMeta", {}).pop(qid, None)
            state["choppedIds"] = sorted(chopped)
            write_json(STATE, state)
            self._send_json(200, {"ok": True, "choppedIds": state["choppedIds"]})
            return

        if path == "/api/reset-practice-wrongs":
            state["practiceWrongs"] = {}
            write_json(STATE, state)
            self._send_json(200, {"ok": True})
            return

        if path == "/api/progress/save":
            mode = data.get("mode")
            if not mode:
                self._send_json(400, {"ok": False, "error": "missing mode"})
                return
            progress = state.setdefault("progressByMode", {})
            progress[mode] = {
                "mode": mode,
                "queueIds": data.get("queueIds") or [],
                "index": int(data.get("index") or 0),
                "session": data.get("session")
                or {"total": 0, "correct": 0, "wrong": 0, "wrongIds": []},
                "shuffle": bool(data.get("shuffle")),
                "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
            }
            write_json(STATE, state)
            self._send_json(200, {"ok": True, "progressByMode": progress})
            return

        if path == "/api/progress/clear":
            mode = data.get("mode")
            progress = state.setdefault("progressByMode", {})
            if mode:
                progress.pop(mode, None)
            else:
                state["progressByMode"] = {}
                progress = {}
            write_json(STATE, state)
            self._send_json(200, {"ok": True, "progressByMode": progress})
            return

        self._send_json(404, {"ok": False, "error": "not found"})


def main():
    ensure_state()
    if not QUESTIONS.exists():
        print("缺少题库文件:", QUESTIONS)
        input("按回车退出...")
        return

    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    url_local = f"http://127.0.0.1:{PORT}/"
    print("=" * 52)
    print("  错题练习已启动")
    print(f"  本机访问: {url_local}")
    for ip in local_ips():
        print(f"  手机访问: http://{ip}:{PORT}/")
    print("  手机需与电脑同一 WiFi；浏览器打开上方地址即可")
    print("  关闭本窗口，或双击 stop.bat，即可停止服务")
    print("=" * 52)

    def _open():
        time.sleep(0.6)
        webbrowser.open(url_local)

    threading.Thread(target=_open, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
