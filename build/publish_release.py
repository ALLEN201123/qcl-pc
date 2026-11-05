# -*- coding: utf-8 -*-
"""创建 GitHub Release v1.0.0 并上传安装包（绕开 curl 在中文 body 上卡住的问题）。"""
import json
import os
import ssl
import subprocess
import sys
import urllib.request
import urllib.error

REPO = "ALLEN201123/qcl-pc"
TAG = "v1.0.0"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOTES = os.path.join(ROOT, "build", "RELEASE_NOTES_1.0.0.md")
ASSET = os.path.join(ROOT, "dist", "QCL-安装程序-1.0.0.exe")
ASSET_NAME = "QCL-安装程序-1.0.0.exe"


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


def make_opener(token_user, token_pass):
    # 本机 hosts 把 github 指向 127.0.0.1（Steam++），证书链可能不带 OCSP；
    # 用不校验证书吊销的 context，和 curl --ssl-no-revoke 等价。
    ctx = ssl.create_default_context()
    ctx.check_hostname = True
    try:
        ctx.verify_flags &= ~ssl.VERIFY_CRL_CHECK_CHAIN
    except Exception:
        pass
    # 若默认校验失败，退回不校验（本机代理场景）
    handlers = [urllib.request.HTTPSHandler(context=ctx)]
    opener = urllib.request.build_opener(*handlers)
    return opener, (token_user, token_pass)


def api(opener, auth, url, method="GET", data=None, headers=None, timeout=60):
    hdr = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "QCL-Release/1.0",
        "Authorization": "Basic " + __import__("base64").b64encode(
            (auth[0] + ":" + auth[1]).encode()
        ).decode(),
    }
    if headers:
        hdr.update(headers)
    req = urllib.request.Request(url, data=data, method=method, headers=hdr)
    with opener.open(req, timeout=timeout) as resp:
        return resp.status, resp.read()


def main():
    with open(NOTES, "r", encoding="utf-8") as f:
        notes = f.read()
    print("release notes 字节数:", len(notes.encode("utf-8")))
    if not os.path.exists(ASSET):
        raise RuntimeError("找不到安装包: " + ASSET)
    print("安装包:", os.path.getsize(ASSET), "字节")

    user, pwd = get_token()
    opener, auth = make_opener(user, pwd)

    # 1) 先查已存在吗
    try:
        status, body = api(opener, auth, f"https://api.github.com/repos/{REPO}/releases/tags/{TAG}")
        print("已存在 release:", status)
        rel = json.loads(body)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        rel = None
        print("没有旧 release，准备创建")

    if rel is None:
        payload = json.dumps({
            "tag_name": TAG,
            "target_commitish": "main",
            "name": "QCL 电脑版 1.0.0 · 首个正式版",
            "body": notes,
            "draft": False,
            "prerelease": False,
        }, ensure_ascii=False).encode("utf-8")
        status, body = api(
            opener, auth,
            f"https://api.github.com/repos/{REPO}/releases",
            method="POST", data=payload,
            headers={"Content-Type": "application/json; charset=utf-8"},
            timeout=120,
        )
        rel = json.loads(body)
        print("创建 release HTTP", status, "id=", rel.get("id"), "url=", rel.get("html_url"))
    else:
        print("复用已有 release id=", rel.get("id"), "url=", rel.get("html_url"))

    # 2) 上传 asset（若已有同名则先删）
    assets = rel.get("assets") or []
    for a in assets:
        if a.get("name") == ASSET_NAME:
            print("删除同名旧资产", a.get("id"))
            api(opener, auth,
                f"https://api.github.com/repos/{REPO}/releases/assets/{a['id']}",
                method="DELETE", timeout=60)

    with open(ASSET, "rb") as f:
        blob = f.read()
    print("开始上传", len(blob), "字节…")
    upload_url = rel["upload_url"].split("{")[0] + "?name=" + urllib.parse.quote(ASSET_NAME)
    status, body = api(
        opener, auth, upload_url, method="POST", data=blob,
        headers={
            "Content-Type": "application/octet-stream",
            "Content-Length": str(len(blob)),
        },
        timeout=600,
    )
    up = json.loads(body)
    print("上传 HTTP", status, "asset id=", up.get("id"), "size=", up.get("size"))
    print("下载页:", up.get("browser_download_url"))

    # 3) 回读校验
    status, body = api(opener, auth, f"https://api.github.com/repos/{REPO}/releases/tags/{TAG}")
    final = json.loads(body)
    print("===== 最终 Release =====")
    print("tag:", final.get("tag_name"), " draft:", final.get("draft"), " prerelease:", final.get("prerelease"))
    print("name:", final.get("name"))
    print("url:", final.get("html_url"))
    print("assets:", [(a.get("name"), a.get("size"), a.get("browser_download_url")) for a in (final.get("assets") or [])])
    body_text = final.get("body") or ""
    print("body 首行:", body_text.splitlines()[0] if body_text else "(空)")
    print("body 含中文:", "QCL 电脑版" in body_text)


if __name__ == "__main__":
    import urllib.parse  # noqa
    try:
        main()
    except Exception as e:
        print("FATAL:", type(e).__name__, str(e))
        sys.exit(1)
