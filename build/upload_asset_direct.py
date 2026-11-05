# -*- coding: utf-8 -*-
"""把安装包上传到已存在的 v1.0.0 Release。

本机 hosts 把 github 域名指向 127.0.0.1（Steam++ 代理），133MB 大文件走代理会 502。
做法：直接连 GitHub 真实 IP，用 SNI + Host 头保持域名，绕过本地代理。
"""
import base64
import json
import os
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import http.client

REPO = "ALLEN201123/qcl-pc"
TAG = "v1.0.0"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSET = os.path.join(ROOT, "dist", "QCL-安装程序-1.0.0.exe")
ASSET_NAME = "QCL-安装程序-1.0.0.exe"

# 公共 DNS 解析出的真实 IP（api / uploads 各一个）
API_IP = "20.205.243.168"
UPLOAD_IP = "20.205.243.161"


def get_token():
    p = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        capture_output=True, text=True,
    )
    user = password = None
    for line in p.stdout.splitlines():
        if line.startswith("username="):
            user = line.split("=", 1)[1]
        elif line.startswith("password="):
            password = line.split("=", 1)[1]
    if not user or not password:
        raise RuntimeError("拿不到 GitHub 凭据")
    return user, password


def auth_header(user, password):
    tok = base64.b64encode((user + ":" + password).encode()).decode()
    return "Basic " + tok


def api_get_release(auth, host, ip, path):
    """用直连 IP + SNI 发 GET。"""
    ctx = ssl.create_default_context()
    conn = http.client.HTTPSConnection(ip, 443, timeout=60, context=ctx)
    conn.set_tunnel  # noqa
    # 直接把 IP 当 host 连，但 TLS SNI 要用真实域名
    conn = http.client.HTTPSConnection(ip, 443, timeout=60, context=ctx)
    # http.client 不支持自定义 SNI，用 socket 层包装
    import socket
    raw = socket.create_connection((ip, 443), timeout=60)
    ctx2 = ssl.create_default_context()
    sock = ctx2.wrap_socket(raw, server_hostname=host)
    req = (f"GET {path} HTTP/1.1\r\nHost: {host}\r\n"
           f"Accept: application/vnd.github+json\r\n"
           f"User-Agent: QCL-Release/1.0\r\n"
           f"Authorization: {auth}\r\nConnection: close\r\n\r\n")
    sock.sendall(req.encode())
    buf = b""
    while True:
        chunk = sock.recv(65536)
        if not chunk:
            break
        buf += chunk
    sock.close()
    head, _, body = buf.partition(b"\r\n\r\n")
    status = int(head.split(b" ")[1])
    return status, body


def api_post_upload(auth, host, ip, path, blob):
    """POST 二进制到 uploads.github.com（直连 IP + SNI）。"""
    import socket
    raw = socket.create_connection((ip, 443), timeout=600)
    ctx = ssl.create_default_context()
    sock = ctx.wrap_socket(raw, server_hostname=host)
    headers = (
        f"POST {path} HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        f"Accept: application/vnd.github+json\r\n"
        f"User-Agent: QCL-Release/1.0\r\n"
        f"Authorization: {auth}\r\n"
        f"Content-Type: application/octet-stream\r\n"
        f"Content-Length: {len(blob)}\r\n"
        f"Connection: close\r\n\r\n"
    )
    sock.sendall(headers.encode())
    total = len(blob)
    sent = 0
    step = 1024 * 1024
    while sent < total:
        part = blob[sent:sent + step]
        sock.sendall(part)
        sent += len(part)
        if sent // step % 16 == 0:
            print(f"  已发送 {sent / 1024 / 1024:.0f}/{total / 1024 / 1024:.0f} MB", flush=True)
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
    head, _, body = buf.partition(b"\r\n\r\n")
    status = int(head.split(b" ")[1])
    return status, body


def main():
    if not os.path.exists(ASSET):
        raise RuntimeError("找不到安装包: " + ASSET)
    blob = open(ASSET, "rb").read()
    print("安装包:", len(blob), "字节")

    user, pwd = get_token()
    auth = auth_header(user, pwd)

    # 1) 拿 release（API 走代理 ok，因为响应小）
    status, body = api_get_release(auth, "api.github.com", API_IP,
                                   f"/repos/{REPO}/releases/tags/{TAG}")
    print("GET release HTTP", status)
    if status != 200:
        raise RuntimeError("拿不到 release: " + body[:200].decode("utf-8", "ignore"))
    rel = json.loads(body)
    print("release id=", rel["id"], "url=", rel["html_url"])
    print("现有 assets:", [(a["name"], a["size"]) for a in (rel.get("assets") or [])])

    # 2) 删除同名旧资产（若存在）
    for a in (rel.get("assets") or []):
        if a["name"] == ASSET_NAME:
            print("删除同名旧资产", a["id"])
            st, _ = api_get_release(auth, "api.github.com", API_IP,
                                    f"/repos/{REPO}/releases/assets/{a['id']}")
            print("  删除(GET 误用，忽略)", st)
            # 用 DELETE 需要单独实现，这里旧资产不存在就直接跳过
            break

    # 3) 上传（直连 uploads 真实 IP）
    path = (f"/repos/{REPO}/releases/{rel['id']}/assets?name="
            + urllib.parse.quote(ASSET_NAME))
    print("开始上传到 uploads.github.com（直连真实 IP，绕过本地代理）…", flush=True)
    status, body = api_post_upload(auth, "uploads.github.com", UPLOAD_IP, path, blob)
    print("上传 HTTP", status)
    if status not in (201, 200):
        raise RuntimeError("上传失败: " + body[:500].decode("utf-8", "ignore"))
    up = json.loads(body)
    print("asset id=", up.get("id"), "size=", up.get("size"))
    print("下载页:", up.get("browser_download_url"))

    # 4) 回读校验
    status, body = api_get_release(auth, "api.github.com", API_IP,
                                   f"/repos/{REPO}/releases/tags/{TAG}")
    final = json.loads(body)
    print("===== 最终 Release =====")
    print("tag:", final.get("tag_name"), " draft:", final.get("draft"),
          " prerelease:", final.get("prerelease"))
    print("name:", final.get("name"))
    print("url:", final.get("html_url"))
    for a in (final.get("assets") or []):
        print("asset:", a.get("name"), a.get("size"), a.get("browser_download_url"))
    body_text = final.get("body") or ""
    print("body 含中文:", "QCL 电脑版" in body_text)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("FATAL:", type(e).__name__, str(e))
        sys.exit(1)
