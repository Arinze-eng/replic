"""http_tool.py — Make HTTP requests from the sandbox."""

import urllib.request
import urllib.error
import json


def run(ctx, args):
    url = args.get("url", "")
    method = args.get("method", "GET").upper()
    headers = args.get("headers", {})
    body = args.get("body")
    timeout = int(args.get("timeout", 60))

    if not url:
        return {"error": "No URL provided", "status": 0}

    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    try:
        req = urllib.request.Request(url, method=method)
        for k, v in headers.items():
            req.add_header(k, v)
        if body is not None:
            if isinstance(body, str):
                req.data = body.encode("utf-8")
            else:
                req.data = body
            if not headers.get("Content-Type") and not headers.get("content-type"):
                req.add_header("Content-Type", "application/json")

        with urllib.request.urlopen(req, timeout=timeout) as resp:
            content = resp.read()
            body_text = content.decode("utf-8", errors="replace")
            return {
                "status": resp.status,
                "headers": dict(resp.headers),
                "body": body_text[:50000],
                "body_bytes": len(content),
                "url": url,
            }
    except urllib.error.HTTPError as e:
        return {
            "status": e.code,
            "headers": dict(e.headers),
            "body": e.read().decode("utf-8", errors="replace")[:5000],
            "error": str(e),
            "url": url,
        }
    except Exception as e:
        return {"status": 0, "body": "", "error": str(e), "url": url}