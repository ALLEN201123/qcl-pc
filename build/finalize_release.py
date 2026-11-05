# -*- coding: utf-8 -*-
"""把资产名固定为 ASCII（GitHub 端会剥掉中文，无法保留中文名）。
同时把 release body 里补上「下载文件名」说明，并回读校验最终状态。
"""
import base64
import json
import socket
import ssl
import subprocess
import sys

REPO = "ALLEN201123/qcl-pc"
TAG = "v1.0.0"
API_IP = "20.205.243.168"
ASCII_NAME = "QCL-Setup-1.0.0.exe"
EXPECTED_SIZE = 133928448


def get_token():
    p = subprocess.run(["git", "credential", "fill"],
                       input="protocol=https\nhost=github.com\n\n",
                       capture_output=True, text=True)
    user = password = None
    for line in p.stdout.splitlines():
        if line.startswith("username="):
            user = line.split("=", 1)[1]
        elif line.startswith("password="):
            password = line.split("=", 1)[1]
    return base64.b64encode((user + ":" + password).encode()).decode()


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


def req(method, path, auth, body=b"", ctype=None, timeout=120):
    raw = socket.create_connection((API_IP, 443), timeout=timeout)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    sock = ctx.wrap_socket(raw, server_hostname="api.github.com")
    hdrs = {
        "Host": "api.github.com",
        "Accept": "application/vnd.github+json",
        "User-Agent": "QCL-Release/1.0",
        "Authorization": "Basic " + auth,
        "Connection": "close",
    }
    if body:
        hdrs["Content-Type"] = ctype or "application/json; charset=utf-8"
        hdrs["Content-Length"] = str(len(body))
    head = f"{method} {path} HTTP/1.1\r\n" + "".join(
        f"{k}: {v}\r\n" for k, v in hdrs.items()) + "\r\n"
    sock.sendall(head.encode("utf-8") + body)
    buf = b""
    sock.settimeout(60)
    while True:
        try:
            c = sock.recv(65536)
        except socket.timeout:
            break
        if not c:
            break
        buf += c
    sock.close()
    head_b, _, body_b = buf.partition(b"\r\n\r\n")
    if b"chunked" in head_b.lower():
        body_b = decode_chunked(body_b)
    return int(head_b.split(b" ")[1]), body_b


def main():
    auth = get_token()
    st, body = req("GET", f"/repos/{REPO}/releases/tags/{TAG}", auth)
    rel = json.loads(body)
    rid = rel["id"]
    print("release id=", rid)

    # 确保只有一个资产，且名字是 ASCII
    assets = rel.get("assets") or []
    for a in assets:
        if a["name"] != ASCII_NAME:
            print("改名资产", a["id"], a["name"], "→", ASCII_NAME)
            payload = json.dumps({"name": ASCII_NAME}).encode()
            st, body = req("PATCH", f"/repos/{REPO}/releases/assets/{a['id']}", auth, payload)
            print("  PATCH HTTP", st, json.loads(body).get("name"))

    # 更新 release body：补一句资产名说明
    note = ("\n\n> 说明：GitHub 对 Release 资产名中的中文字符会自动过滤，"
            "因此下载附件名为 `QCL-Setup-1.0.0.exe`（与本仓库 "
            "`QCL-安装程序-1.0.0.exe` 是同一个文件，SHA256 一致）。")
    newbody = (rel.get("body") or "").rstrip() + note
    payload = json.dumps({"body": newbody}, ensure_ascii=False).encode("utf-8")
    st, body = req("PATCH", f"/repos/{REPO}/releases/{rid}", auth, payload)
    print("更新 body HTTP", st)

    # 最终回读
    st, body = req("GET", f"/repos/{REPO}/releases/tags/{TAG}", auth)
    f = json.loads(body)
    print("===== 最终 Release =====")
    print("tag:", f.get("tag_name"), " draft:", f.get("draft"), " prerelease:", f.get("prerelease"))
    print("name:", f.get("name"))
    print("url:", f.get("html_url"))
    print("published_at:", f.get("published_at"))
    ok = False
    for a in (f.get("assets") or []):
        print("asset:", a.get("name"), a.get("size"), a.get("browser_download_url"))
        if a.get("name") == ASCII_NAME and a.get("size") == EXPECTED_SIZE:
            ok = True
    print("body 含中文:", "QCL 电脑版" in (f.get("body") or ""))
    print("body 含资产名说明:", "QCL-Setup" in (f.get("body") or ""))
    print("RESULT:", "OK" if ok else "FAIL")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("FATAL:", type(e).__name__, str(e))
        sys.exit(1)
