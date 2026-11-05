# -*- coding: utf-8 -*-
"""重新上传 1.0.0 Release 资产（内容更新，版本号仍 1.0.0）。

- 删掉旧资产，上传新构建的安装包（ASCII 名 QCL-Setup-1.0.0.exe，中文名会被 GitHub 剥掉）
- 顺带更新 Release 正文里的 SHA256
- 直连 GitHub 真实 IP 绕过本机 Steam++ 代理（大文件走代理会 502）
"""
import base64
import hashlib
import json
import os
import socket
import ssl
import subprocess
import sys

REPO = "ALLEN201123/qcl-pc"
TAG = "v1.0.0"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSET = os.path.join(ROOT, "dist", "QCL-安装程序-1.0.0.exe")
ASSET_NAME = "QCL-Setup-1.0.0.exe"
API_IP = "20.205.243.168"
UPLOAD_IP = "20.205.243.161"


def get_token():
    p = subprocess.run(["git", "credential", "fill"],
                       input="protocol=https\nhost=github.com\n\n",
                       capture_output=True, text=True)
    u = pw = None
    for line in p.stdout.splitlines():
        if line.startswith("username="):
            u = line.split("=", 1)[1]
        elif line.startswith("password="):
            pw = line.split("=", 1)[1]
    if not u or not pw:
        raise RuntimeError("拿不到凭据")
    return base64.b64encode((u + ":" + pw).encode()).decode()


def decode_chunked(b):
    out, rest = b"", b
    while rest:
        line, _, rest = rest.partition(b"\r\n")
        try:
            n = int(line.split(b";")[0], 16)
        except ValueError:
            break
        if n == 0:
            break
        out += rest[:n]
        rest = rest[n + 2:]
    return out


def req(host, ip, method, path, auth, body=b"", ctype=None, timeout=600):
    raw = socket.create_connection((ip, 443), timeout=timeout)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    sock = ctx.wrap_socket(raw, server_hostname=host)
    hdrs = {
        "Host": host,
        "Accept": "application/vnd.github+json",
        "User-Agent": "QCL-Release/1.0",
        "Authorization": "Basic " + auth,
        "Connection": "close",
    }
    if body:
        hdrs["Content-Type"] = ctype or "application/octet-stream"
        hdrs["Content-Length"] = str(len(body))
    head = f"{method} {path} HTTP/1.1\r\n" + "".join(
        f"{k}: {v}\r\n" for k, v in hdrs.items()) + "\r\n"
    sock.sendall(head.encode("utf-8"))
    if body:
        step = 1024 * 1024
        sent = 0
        while sent < len(body):
            sock.sendall(body[sent:sent + step])
            sent += min(step, len(body) - sent)
            if (sent // step) % 32 == 0:
                print(f"  {sent/1024/1024:.0f}/{len(body)/1024/1024:.0f} MB", flush=True)
    buf = b""
    sock.settimeout(120)
    while True:
        try:
            c = sock.recv(65536)
        except socket.timeout:
            break
        if not c:
            break
        buf += c
    sock.close()
    h, _, b = buf.partition(b"\r\n\r\n")
    if b"chunked" in h.lower():
        b = decode_chunked(b)
    return int(h.split(b" ")[1]), b


def main():
    if not os.path.exists(ASSET):
        raise RuntimeError("找不到安装包")
    blob = open(ASSET, "rb").read()
    sha = hashlib.sha256(blob).hexdigest().upper()
    print("新包:", len(blob), "字节  SHA256:", sha)
    auth = get_token()

    # 1) 拿现有 release
    st, body = req("api.github.com", API_IP, "GET",
                   f"/repos/{REPO}/releases/tags/{TAG}", auth, timeout=60)
    if st != 200:
        raise RuntimeError("拿不到 release HTTP " + str(st))
    rel = json.loads(body)
    rid = rel["id"]
    print("release id:", rid, " 旧资产:", [(a["name"], a["size"]) for a in (rel.get("assets") or [])])

    # 2) 删旧资产
    for a in (rel.get("assets") or []):
        print("删除旧资产", a["id"], a["name"])
        st, _ = req("api.github.com", API_IP, "DELETE",
                    f"/repos/{REPO}/releases/assets/{a['id']}", auth, timeout=60)
        print("  DELETE HTTP", st)

    # 3) 上传新包
    path = f"/repos/{REPO}/releases/{rid}/assets?name={ASSET_NAME}"
    print("上传新包…", flush=True)
    st, body = req("uploads.github.com", UPLOAD_IP, "POST", path, auth, blob)
    print("上传 HTTP", st)
    if st != 201:
        print(body[:400].decode("utf-8", "ignore"))
        raise RuntimeError("上传失败")
    up = json.loads(body)
    print("新资产 id=", up["id"], " size=", up["size"], " name=", up["name"])

    # 4) 更新正文里的 SHA256
    note = (f"\n\n---\n**本 Release 已于 2026-11-05 更新**：资产替换为修复后的构建，"
            f"SHA256 `{sha}`（本地 `QCL-安装程序-1.0.0.exe` 与之一致）。\n"
            f"本次修复：全部远古版本（含官方已删除、Betacraft 收录的 74 个周快照）"
            f"自动注入两行 Java 参数；快照分页补归档版本；新增更新推送检查。")
    old = rel.get("body") or ""
    # 去掉上一次可能追加的「已更新」段，避免越堆越长
    if "\n\n---\n**本 Release 已于" in old:
        old = old.split("\n\n---\n**本 Release 已于")[0]
    payload = json.dumps({"body": old.rstrip() + note}, ensure_ascii=False).encode("utf-8")
    st, body = req("api.github.com", API_IP, "PATCH",
                   f"/repos/{REPO}/releases/{rid}", auth, payload,
                   ctype="application/json; charset=utf-8", timeout=60)
    print("更新正文 HTTP", st)

    # 5) 回读校验
    st, body = req("api.github.com", API_IP, "GET",
                   f"/repos/{REPO}/releases/tags/{TAG}", auth, timeout=60)
    f = json.loads(body)
    print("===== 重新上传后的 Release =====")
    print("tag:", f.get("tag_name"), " draft:", f.get("draft"))
    print("url:", f.get("html_url"))
    ok = False
    for a in (f.get("assets") or []):
        print("asset:", a.get("name"), a.get("size"), a.get("browser_download_url"))
        if a.get("name") == ASSET_NAME and a.get("size") == len(blob):
            ok = True
    print("正文含新 SHA256:", sha in (f.get("body") or ""))
    print("RESULT:", "OK" if ok else "FAIL")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("FATAL:", type(e).__name__, str(e))
        sys.exit(1)
