#!/usr/bin/env python3
"""deepseek_tool.py — Probe DeepSeek AI API endpoints.

Tests the official API at api.deepseek.com, reverse-engineers the chat
endpoint, and verifies that the AI actually responds to queries like
"How are you?" with a real response.

Approach:
  1. Probe the official OpenAI-compatible API endpoint
  2. Probe the web chat endpoint (reverse-engineered)
  3. Test with various auth headers to find the right format
  4. Verify the response is real and coherent
"""

import os
import sys
import json
import time
import urllib.request
import urllib.error
import urllib.parse
import ssl
import traceback
import re
import subprocess


# ── Known DeepSeek endpoints ─────────────────────────────────────────────────
ENDPOINTS = {
    "official_chat": {
        "url": "https://api.deepseek.com/chat/completions",
        "description": "Official OpenAI-compatible API endpoint",
        "auth_format": "Bearer sk-...",
        "model": "deepseek-chat",
    },
    "official_beta": {
        "url": "https://api.deepseek.com/beta/chat/completions",
        "description": "Official beta API endpoint",
        "auth_format": "Bearer sk-...",
        "model": "deepseek-chat",
    },
    "official_anthropic": {
        "url": "https://api.deepseek.com/anthropic/v1/messages",
        "description": "Official Anthropic-compatible API endpoint",
        "auth_format": "Bearer sk-...",
        "model": "deepseek-chat",
    },
    "web_chat_v1": {
        "url": "https://chat.deepseek.com/api/v0/chat/completions",
        "description": "Web chat API (reverse-engineered, may require auth token)",
        "auth_format": "Bearer <session_token>",
        "model": "deepseek-chat",
    },
    "web_chat_v2": {
        "url": "https://chat.deepseek.com/api/chat",
        "description": "Web chat endpoint (reverse-engineered)",
        "auth_format": "session_token header",
        "model": "deepseek-chat",
    },
    "web_chat_legacy": {
        "url": "https://api.deepseek.com/v1/chat/completions",
        "description": "Legacy API v1 endpoint",
        "auth_format": "Bearer sk-...",
        "model": "deepseek-chat",
    },
    "web_chat_stream": {
        "url": "https://api.deepseek.com/chat/completions",
        "description": "Official streaming endpoint",
        "auth_format": "Bearer sk-...",
        "model": "deepseek-chat",
    },
    "web_chat_models": {
        "url": "https://api.deepseek.com/models",
        "description": "Models listing endpoint",
        "auth_format": "Bearer sk-...",
        "method": "GET",
    },
}


def run(ctx, args):
    action = args.get("action", "probe_all")
    api_key = args.get("api_key", "")
    prompt = args.get("prompt", "Reply in one word: how are you?")
    model = args.get("model", "deepseek-chat")
    custom_endpoint = args.get("endpoint", "")

    if action == "list_endpoints":
        return _list_endpoints()

    if action == "probe_official":
        return _probe_endpoint("official_chat", api_key, prompt, model)

    if action == "probe_chat":
        return _probe_all_chat_endpoints(api_key, prompt, model)

    if action == "test_api_key":
        return _test_api_key(api_key, prompt, model)

    if action == "probe_all":
        return _probe_all(api_key, prompt, model)

    if custom_endpoint:
        return _probe_url(custom_endpoint, api_key, prompt, model)

    return {"error": f"Unknown action: {action}"}


def _list_endpoints():
    eps = []
    for name, info in ENDPOINTS.items():
        eps.append({
            "name": name,
            "url": info["url"],
            "description": info["description"],
            "auth_format": info["auth_format"],
            "method": info.get("method", "POST"),
        })
    return {"action": "list_endpoints", "endpoints": eps, "total": len(eps)}


def _probe_all(api_key, prompt, model):
    results = {}
    for name, info in ENDPOINTS.items():
        try:
            r = _probe_url(info["url"], api_key, prompt, model, info.get("method", "POST"))
            results[name] = r
        except Exception as e:
            results[name] = {"error": str(e), "status": 0}

    # Determine which endpoints are alive
    alive = [name for name, r in results.items() if r.get("status") in (200, 201, 401, 403)]
    working = [name for name, r in results.items() if r.get("status") == 200]
    needs_auth = [name for name, r in results.items() if r.get("status") == 401]

    return {
        "action": "probe_all",
        "endpoints_tested": len(results),
        "alive": alive,
        "working_without_key": working,
        "needs_auth_key": needs_auth,
        "endpoints": results,
    }


def _probe_all_chat_endpoints(api_key, prompt, model):
    chat_endpoints = {k: v for k, v in ENDPOINTS.items() if "chat" in k or "web" in k}
    results = {}
    for name, info in chat_endpoints.items():
        r = _probe_url(info["url"], api_key, prompt, model, info.get("method", "POST"))
        results[name] = r

    return {
        "action": "probe_chat",
        "endpoints_tested": len(results),
        "results": results,
    }


def _test_api_key(api_key, prompt, model):
    if not api_key:
        return {"error": "No API key provided. To get a DeepSeek API key: visit https://platform.deepseek.com/api_keys"}

    results = {}
    # Test with different auth header formats
    auth_formats = [
        ("Bearer " + api_key, "Bearer sk-..."),
        ("Bearer " + api_key.replace("sk-", ""), "Bearer without sk-"),
        (api_key, "Raw token"),
    ]

    for auth_value, fmt_name in auth_formats:
        try:
            r = _probe_url("https://api.deepseek.com/chat/completions", auth_value, prompt, model, auth_header=auth_value)
            results[fmt_name] = r
        except Exception as e:
            results[fmt_name] = {"error": str(e), "status": 0}

    # Also test the models endpoint
    try:
        req = urllib.request.Request("https://api.deepseek.com/models")
        req.add_header("Authorization", f"Bearer {api_key}")
        req.add_header("Accept", "application/json")
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
            models = data.get("data", [])[:20]
            results["models_list"] = {
                "status": resp.status,
                "models": [m.get("id") for m in models],
                "model_count": len(models),
            }
    except urllib.error.HTTPError as e:
        results["models_list"] = {"status": e.code, "error": e.read().decode()[:200]}
    except Exception as e:
        results["models_list"] = {"status": 0, "error": str(e)}

    return {
        "action": "test_api_key",
        "key_format": api_key[:10] + "..." + api_key[-4:] if len(api_key) > 14 else "***",
        "results": results,
    }


def _probe_endpoint(endpoint_name, api_key, prompt, model):
    info = ENDPOINTS.get(endpoint_name)
    if not info:
        return {"error": f"Unknown endpoint: {endpoint_name}"}
    return _probe_url(info["url"], api_key, prompt, model, info.get("method", "POST"))


def _probe_url(url, api_key, prompt, model, method="POST", auth_header=None):
    """Probe a single URL and return detailed results."""
    start_time = time.time()
    result = {
        "url": url,
        "method": method,
        "status": 0,
        "response_time": 0,
        "response": "",
        "headers": {},
        "error": None,
    }

    try:
        if method == "GET":
            req = urllib.request.Request(url, method="GET")
        else:
            body = json.dumps({
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 50,
                "temperature": 0.0,
            }).encode("utf-8")
            req = urllib.request.Request(url, data=body, method="POST")
            req.add_header("Content-Type", "application/json")

        # Try auth header
        if auth_header:
            req.add_header("Authorization", auth_header)
        elif api_key:
            req.add_header("Authorization", f"Bearer {api_key}")

        req.add_header("Accept", "application/json")
        req.add_header("User-Agent", "DeepSeekProbe/1.0")

        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

        with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
            result["status"] = resp.status
            result["response_time"] = round(time.time() - start_time, 2)
            result["headers"] = dict(resp.headers)
            body = resp.read().decode("utf-8", errors="replace")

            # Parse response
            try:
                data = json.loads(body)
                result["response"] = data

                # Extract the actual AI response if available
                if "choices" in data:
                    choice = data["choices"][0]
                    if "message" in choice:
                        result["ai_response"] = choice["message"].get("content", "")
                    elif "delta" in choice:
                        result["ai_response"] = choice["delta"].get("content", "")
                elif "content" in data:
                    result["ai_response"] = data["content"]

            except json.JSONDecodeError:
                result["response"] = body[:2000]

    except urllib.error.HTTPError as e:
        result["status"] = e.code
        result["response_time"] = round(time.time() - start_time, 2)
        result["headers"] = dict(e.headers)
        try:
            result["response"] = json.loads(e.read().decode("utf-8", errors="replace"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            result["response"] = e.read().decode("utf-8", errors="replace")[:1000]
        result["error"] = f"HTTP {e.code}"

    except urllib.error.URLError as e:
        result["response_time"] = round(time.time() - start_time, 2)
        result["error"] = f"URL Error: {e.reason}"

    except Exception as e:
        result["response_time"] = round(time.time() - start_time, 2)
        result["error"] = str(e)

    return result