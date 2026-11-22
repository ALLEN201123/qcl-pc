# -*- coding: utf-8 -*-
"""补传 v1.0.5 的安装包资产（该 Release 的 assets 是空的）。

原因：1.0.5 那次发布被中途打断，Release 建好了但资产没传上去。
本地包完好（sha256 FD964F72…），直接补传即可。

- 上传到已有的 v1.0.5 Release（不改 tag、不改版本号）
- 顺带在正文补一行说明
- 断言上传后 assets 非空且大小正确
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
TAG = "v1.0.5"
VERSION = "1.0.5"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSET = os.path.join(ROOT, "dist", f"QCL-安装程序-{VERSION}.exe")
ASSET_NAME = f"QCL-Setup-{VERSION}.exe"   # GitHub 会过滤资产名里的中文
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
        raise RuntimeError("找不到本地 1.0.5 安装包: " + ASSET)
    blob = open(ASSET, "rb").read()
    sha = hashlib.sha256(blob).hexdigest().upper()
    print("本地包:", len(blob), "字节  SHA256:", sha)
    auth = get_token()

    # 1) 找到 v1.0.5 的 release
    st, body = req("api.github.com", API_IP, "GET",
                   f"/repos/{REPO}/releases/tags/{TAG}", auth, timeout=60)
    if st != 200:
        raise RuntimeError(f"拿不到 {TAG} 的 release（HTTP {st}）")
    rel = json.loads(body)
    rid = rel["id"]
    old_assets = rel.get("assets") or []
    print("release id:", rid)
    print("现有资产:", [(a["name"], a["size"]) for a in old_assets] or "（空 —— 就是这次要修的）")

    # 2) 清掉可能残留的坏资产
    for a in old_assets:
        print("删除旧资产", a["id"], a["name"], a["size"], "字节")
        st, _ = req("api.github.com", API_IP, "DELETE",
                    f"/repos/{REPO}/releases/assets/{a['id']}", auth, timeout=60)
        print("  DELETE", st)

    # 3) 上传
    path = f"/repos/{REPO}/releases/{rid}/assets?name={ASSET_NAME}"
    print("上传安装包…", flush=True)
    st, body = req("uploads.github.com", UPLOAD_IP, "POST", path, auth, blob)
    print("上传 HTTP", st)
    if st != 201:
        print(body[:400].decode("utf-8", "ignore"))
        raise RuntimeError("上传失败")
    up = json.loads(body)
    print("asset id=", up["id"], " size=", up["size"], " name=", up["name"])

    # 4) 正文补一行「已修复」
    notes = ""
    if os.path.exists(NOTES):
        notes = open(NOTES, encoding="utf-8").read()
    cur = rel.get("body") or notes
    note = (f"\n\n---\n**2026-11-22 补齐资产**：本 Release 首次发布时上传中断，"
            f"assets 为空；现已补传 `{ASSET_NAME}`（{len(blob)} 字节，"
            f"SHA256 `{sha}`）。")
    if "\n\n---\n**2026-11-22 补齐资产**" in cur:
        cur = cur.split("\n\n---\n**2026-11-22 补齐资产**")[0]
    payload = json.dumps({"body": cur.rstrip() + note}, ensure_ascii=False).encode("utf-8")
    st, _ = req("api.github.com", API_IP, "PATCH",
                f"/repos/{REPO}/releases/{rid}", auth, payload,
                ctype="application/json; charset=utf-8", timeout=60)
    print("更新正文 HTTP", st)

    # 5) 回读断言
    st, body = req("api.github.com", API_IP, "GET",
                   f"/repos/{REPO}/releases/tags/{TAG}", auth, timeout=60)
    f = json.loads(body)
    assets = f.get("assets") or []
    print("===== 回读 =====")
    print("tag:", f.get("tag_name"), " draft:", f.get("draft"))
    ok = False
    for a in assets:
        print("asset:", a.get("name"), a.get("size"), a.get("browser_download_url"))
        if a.get("name") == ASSET_NAME and a.get("size") == len(blob):
            ok = True
    print("资产非空:", len(assets) > 0)
    print("大小匹配本地:", ok)
    print("正文含 SHA:", sha in (f.get("body") or ""))
    print("RESULT:", "OK" if ok and assets else "FAIL")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("FATAL:", type(e).__name__, str(e))
        sys.exit(1)
