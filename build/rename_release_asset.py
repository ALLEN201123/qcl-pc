# -*- coding: utf-8 -*-
"""用纯 ASCII 名上传资产，再通过 PATCH /releases/assets/{id}（JSON body）改回中文名。

原因：本机代理会把 URL query 里的中文剥掉，导致 ?name=QCL-安装程序-1.0.0.exe
上传后变成 QCL-.-1.0.0.exe。改名走 JSON body（不经 URL）可绕开。
"""
import base64
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

API_IP = "20.205.243.168"
UPLOAD_IP = "20.205.243.161"

ASCII_NAME = "QCL-Setup-1.0.0.exe"
PLAIN_NAME = "QCL-安装程序-1.0.0.exe"


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
    if not user or not password:
        raise RuntimeError("拿不到 GitHub 凭据")
    return base64.b64encode((user + ":" + password).encode()).decode()


def decode_chunked(body_b):
    out = b""
    rest = body_b
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


def get_ssl_context():
    """本机 Steam++ 代理的 TLS 中间层证书缺颁发者链，直连 IP 时无法验证。
    仅对**上传大文件**的这条连接关闭校验；API 小请求走本机代理（证书正常）。"""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def request(host, ip, method, path, auth, body=b"", content_type=None, timeout=600):
    raw = socket.create_connection((ip, 443), timeout=timeout)
    ctx = get_ssl_context()
    sock = ctx.wrap_socket(raw, server_hostname=host)
    hdrs = {
        "Host": host,
        "Accept": "application/vnd.github+json",
        "User-Agent": "QCL-Release/1.0",
        "Authorization": "Basic " + auth,
        "Connection": "close",
    }
    if body:
        hdrs["Content-Type"] = content_type or "application/octet-stream"
        hdrs["Content-Length"] = str(len(body))
    head = f"{method} {path} HTTP/1.1\r\n" + "".join(
        f"{k}: {v}\r\n" for k, v in hdrs.items()) + "\r\n"
    sock.sendall(head.encode("utf-8"))
    if body:
        step = 1024 * 1024
        sent = 0
        while sent < len(body):
            part = body[sent:sent + step]
            sock.sendall(part)
            sent += len(part)
            if (sent // step) % 24 == 0:
                print(f"  已发送 {sent/1024/1024:.0f}/{len(body)/1024/1024:.0f} MB", flush=True)
    buf = b""
    sock.settimeout(120)
    while True:
        try:
            chunk = sock.recv(65536)
        except socket.timeout:
            break
        if not chunk:
            break
        buf += chunk
    sock.close()
    head_b, _, body_b = buf.partition(b"\r\n\r\n")
    status = int(head_b.split(b" ")[1])
    if b"chunked" in head_b.lower():
        body_b = decode_chunked(body_b)
    return status, body_b


def main():
    if not os.path.exists(ASSET):
        raise RuntimeError("找不到安装包: " + ASSET)
    blob = open(ASSET, "rb").read()
    print("安装包:", len(blob), "字节")
    auth = get_token()

    # 1) 拿 release
    st, body = request("api.github.com", API_IP, "GET",
                       f"/repos/{REPO}/releases/tags/{TAG}", auth)
    rel = json.loads(body)
    rid = rel["id"]
    print("release id=", rid, " url=", rel["html_url"])

    # 2) 删所有旧资产
    for a in (rel.get("assets") or []):
        print("删除旧资产", a["id"], a["name"])
        st, _ = request("api.github.com", API_IP, "DELETE",
                        f"/repos/{REPO}/releases/assets/{a['id']}", auth)
        print("  DELETE HTTP", st)

    # 3) 纯 ASCII 名上传
    path = f"/repos/{REPO}/releases/{rid}/assets?name={ASCII_NAME}"
    print("用 ASCII 名上传:", ASCII_NAME, flush=True)
    st, body = request("uploads.github.com", UPLOAD_IP, "POST", path, auth, blob)
    print("上传 HTTP", st)
    if st != 201:
        print("响应:", body[:400].decode("utf-8", "ignore"))
        raise RuntimeError("上传失败")
    up = json.loads(body)
    aid = up["id"]
    print("asset id=", aid, " name=", up.get("name"), " size=", up.get("size"))

    # 4) PATCH 改名（中文在 JSON body 里，不经过 URL）
    payload = json.dumps({"name": PLAIN_NAME}, ensure_ascii=False).encode("utf-8")
    print("PATCH 改名为:", PLAIN_NAME)
    st, body = request("api.github.com", API_IP, "PATCH",
                       f"/repos/{REPO}/releases/assets/{aid}", auth, payload,
                       content_type="application/json; charset=utf-8")
    print("PATCH HTTP", st)
    if st == 200:
        renamed = json.loads(body)
        print("改后 name=", renamed.get("name"))
    else:
        print("PATCH 响应:", body[:300].decode("utf-8", "ignore"))

    # 5) 回读校验
    st, body = request("api.github.com", API_IP, "GET",
                       f"/repos/{REPO}/releases/tags/{TAG}", auth)
    final = json.loads(body)
    print("===== 最终 Release =====")
    print("tag:", final.get("tag_name"), " draft:", final.get("draft"),
          " prerelease:", final.get("prerelease"))
    print("name:", final.get("name"))
    print("url:", final.get("html_url"))
    ok = False
    for a in (final.get("assets") or []):
        print("asset:", a.get("name"), a.get("size"), a.get("browser_download_url"))
        if a.get("name") == PLAIN_NAME and a.get("size") == len(blob):
            ok = True
    print("body 含中文:", "QCL 电脑版" in (final.get("body") or ""))
    print("RESULT:", "OK" if ok else "FAIL")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("FATAL:", type(e).__name__, str(e))
        sys.exit(1)
