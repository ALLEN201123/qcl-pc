# -*- coding: utf-8 -*-
"""发布 v1.0.3：建 Release + 上传安装包（直连 GitHub 真实 IP，绕开本机 Steam++ 代理）。"""
import base64
import hashlib
import json
import os
import socket
import ssl
import subprocess
import sys

REPO = "ALLEN201123/qcl-pc"
TAG = "v1.0.3"
VERSION = "1.0.3"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSET = os.path.join(ROOT, "dist", f"QCL-安装程序-{VERSION}.exe")
ASSET_NAME = f"QCL-Setup-{VERSION}.exe"   # GitHub 会剥掉资产名里的中文
NOTES = os.path.join(ROOT, "build", f"RELEASE_NOTES_{VERSION}.md")
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
        raise RuntimeError("拿不到 GitHub 凭据")
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
        raise RuntimeError("找不到安装包: " + ASSET)
    if not os.path.exists(NOTES):
        raise RuntimeError("找不到 Release 说明: " + NOTES)
    blob = open(ASSET, "rb").read()
    sha = hashlib.sha256(blob).hexdigest().upper()
    notes = open(NOTES, encoding="utf-8").read()
    print("安装包:", len(blob), "字节  SHA256:", sha)
    print("说明:", len(notes.encode("utf-8")), "字节")
    auth = get_token()

    # 1) 已存在就复用
    st, body = req("api.github.com", API_IP, "GET",
                   f"/repos/{REPO}/releases/tags/{TAG}", auth, timeout=60)
    if st == 200:
        rel = json.loads(body)
        print("已存在 release id=", rel["id"], "→ 复用")
    elif st == 404:
        payload = json.dumps({
            "tag_name": TAG,
            "target_commitish": "main",
            "name": f"QCL 电脑版 {VERSION} · 修复实例图标不生效",
            "body": notes,
            "draft": False,
            "prerelease": False,
        }, ensure_ascii=False).encode("utf-8")
        st, body = req("api.github.com", API_IP, "POST",
                       f"/repos/{REPO}/releases", auth, payload,
                       ctype="application/json; charset=utf-8", timeout=120)
        if st != 201:
            print("创建失败:", body[:400].decode("utf-8", "ignore"))
            raise RuntimeError(f"创建 release HTTP {st}")
        rel = json.loads(body)
        print("创建 release HTTP", st, "id=", rel["id"], rel["html_url"])
    else:
        raise RuntimeError(f"查询 release HTTP {st}")

    rid = rel["id"]

    # 2) 删掉同名旧资产
    for a in (rel.get("assets") or []):
        print("删除旧资产", a["id"], a["name"])
        st, _ = req("api.github.com", API_IP, "DELETE",
                    f"/repos/{REPO}/releases/assets/{a['id']}", auth, timeout=60)
        print("  DELETE", st)

    # 3) 上传安装包
    path = f"/repos/{REPO}/releases/{rid}/assets?name={ASSET_NAME}"
    print("上传安装包…", flush=True)
    st, body = req("uploads.github.com", UPLOAD_IP, "POST", path, auth, blob)
    print("上传 HTTP", st)
    if st != 201:
        print(body[:400].decode("utf-8", "ignore"))
        raise RuntimeError("上传失败")
    up = json.loads(body)
    print("asset id=", up["id"], " size=", up["size"], " name=", up["name"])

    # 4) 正文补 SHA256（资产名说明）
    note = (f"\n\n---\n**校验**：`SHA256 {sha}`（本地文件名 `QCL-安装程序-{VERSION}.exe`，"
            f"与附件 `{ASSET_NAME}` 为同一文件；GitHub 会过滤资产名中的中文，故附件用 ASCII 名）。")
    newbody = (rel.get("body") or notes).rstrip() + note
    payload = json.dumps({"body": newbody}, ensure_ascii=False).encode("utf-8")
    st, body = req("api.github.com", API_IP, "PATCH",
                   f"/repos/{REPO}/releases/{rid}", auth, payload,
                   ctype="application/json; charset=utf-8", timeout=60)
    print("更新正文 HTTP", st)

    # 5) 回读校验
    st, body = req("api.github.com", API_IP, "GET",
                   f"/repos/{REPO}/releases/tags/{TAG}", auth, timeout=60)
    f = json.loads(body)
    print("===== Release =====")
    print("tag:", f.get("tag_name"), "draft:", f.get("draft"), "prerelease:", f.get("prerelease"))
    print("name:", f.get("name"))
    print("url:", f.get("html_url"))
    ok = False
    for a in (f.get("assets") or []):
        print("asset:", a.get("name"), a.get("size"), a.get("browser_download_url"))
        if a.get("name") == ASSET_NAME and a.get("size") == len(blob):
            ok = True
    print("正文含 SHA256:", sha in (f.get("body") or ""))
    print("正文含中文:", "QCL 电脑版" in (f.get("body") or ""))
    print("RESULT:", "OK" if ok else "FAIL")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("FATAL:", type(e).__name__, str(e))
        sys.exit(1)
