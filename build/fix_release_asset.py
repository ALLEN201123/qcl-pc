# -*- coding: utf-8 -*-
"""修复 Release 资产文件名：删掉乱码资产，用正确 percent-encoded 中文名重传。

本机 hosts 把 github 域名指向 127.0.0.1（Steam++ 代理），大文件走代理会 502。
直连 GitHub 真实 IP + TLS SNI（server_hostname 保持域名），绕过本地代理。
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

# 硬编码 percent-encoded 中文名，避免任何编码环节出错
# QCL-安装程序-1.0.0.exe
ENC_NAME = "QCL-%E5%AE%89%E8%A3%85%E7%A8%8B%E5%BA%8F-1.0.0.exe"
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


def request(host, ip, method, path, auth, body=b"", extra_headers=None, timeout=600):
    """直连 IP + TLS SNI，发一个完整 HTTP/1.1 请求并返回 (status, body_bytes)。"""
    raw = socket.create_connection((ip, 443), timeout=timeout)
    ctx = ssl.create_default_context()
    sock = ctx.wrap_socket(raw, server_hostname=host)
    hdrs = {
        "Host": host,
        "Accept": "application/vnd.github+json",
        "User-Agent": "QCL-Release/1.0",
        "Authorization": "Basic " + auth,
        "Connection": "close",
    }
    if body:
        hdrs["Content-Type"] = "application/octet-stream"
        hdrs["Content-Length"] = str(len(body))
    if extra_headers:
        hdrs.update(extra_headers)
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
    # 处理 Transfer-Encoding: chunked
    if b"chunked" in head_b.lower():
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
        body_b = out
    return status, body_b


def main():
    if not os.path.exists(ASSET):
        raise RuntimeError("找不到安装包: " + ASSET)
    blob = open(ASSET, "rb").read()
    print("安装包:", len(blob), "字节")
    auth = get_token()

    # 1) 拿 release + 现有资产
    st, body = request("api.github.com", API_IP, "GET",
                       f"/repos/{REPO}/releases/tags/{TAG}", auth)
    print("GET release HTTP", st)
    rel = json.loads(body)
    rid = rel["id"]
    print("release id=", rid, " url=", rel["html_url"])
    for a in (rel.get("assets") or []):
        print("  现有资产:", a["name"], a["id"], a["size"])

    # 2) 删掉所有旧资产（乱码的 + 任何同名）
    for a in (rel.get("assets") or []):
        print("删除旧资产", a["id"], a["name"])
        st, _ = request("api.github.com", API_IP, "DELETE",
                        f"/repos/{REPO}/releases/assets/{a['id']}", auth)
        print("  DELETE HTTP", st)

    # 3) 用硬编码 percent-encoded 中文名重传
    path = f"/repos/{REPO}/releases/{rid}/assets?name={ENC_NAME}"
    print("上传 URL path:", path, flush=True)
    st, body = request("uploads.github.com", UPLOAD_IP, "POST", path, auth, blob)
    print("上传 HTTP", st)
    if st != 201:
        print("响应:", body[:400].decode("utf-8", "ignore"))
        raise RuntimeError("上传失败")
    up = json.loads(body)
    print("asset id=", up.get("id"), " name=", up.get("name"), " size=", up.get("size"))

    # 4) 回读校验
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
    print("RESULT:", "OK" if ok else "FAIL(名字或大小不对)")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("FATAL:", type(e).__name__, str(e))
        sys.exit(1)
