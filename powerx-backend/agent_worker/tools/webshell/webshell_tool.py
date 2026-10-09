"""webshell_tool.py — b374k-style web shell for interactive terminal access."""

import os
import json
import subprocess
import threading
import socket
import base64
import hashlib
from http.server import HTTPServer, BaseHTTPRequestHandler


_webshell_servers = {}
_webshell_lock = threading.Lock()


def run(ctx, args):
    port = int(args.get("port", 8888))
    action = args.get("action", "start")
    auth_token = args.get("auth_token", "")

    if action == "stop":
        with _webshell_lock:
            key = f"{ctx.work_dir}:{port}"
            if key in _webshell_servers:
                _webshell_servers[key].shutdown()
                del _webshell_servers[key]
                return {"status": "stopped", "port": port}
            return {"status": "not_running", "port": port}

    if action == "status":
        with _webshell_lock:
            key = f"{ctx.work_dir}:{port}"
            running = key in _webshell_servers
            return {"status": "running" if running else "stopped", "port": port}

    # Check if already running
    with _webshell_lock:
        key = f"{ctx.work_dir}:{port}"
        if key in _webshell_servers:
            return {"status": "already_running", "port": port, "url": f"http://0.0.0.0:{port}/"}

    # Start web shell
    class WebShellHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/":
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_header()
                html = _build_shell_html(port, auth_token)
                self.wfile.write(html.encode())
            elif self.path == "/exec" or self.path.startswith("/exec?"):
                self._handle_exec()
            elif self.path == "/ping":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_header()
                self.wfile.write(json.dumps({"ok": True}).encode())
            else:
                self.send_response(404)
                self.end_header()

        def do_POST(self):
            if self.path == "/exec":
                self._handle_exec()
            else:
                self.send_response(404)
                self.end_header()

        def _handle_exec(self):
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len) if content_len else b""
            try:
                data = json.loads(body) if body else {}
            except json.JSONDecodeError:
                data = {}

            cmd = data.get("cmd", "") or self.path.split("?cmd=", 1)[1] if "?cmd=" in self.path else ""
            token = data.get("token", "")

            if auth_token and token != auth_token:
                self._send_json({"error": "Invalid auth token"})
                return

            if not cmd:
                self._send_json({"error": "No command"})
                return

            try:
                result = subprocess.run(
                    cmd, shell=True, cwd=ctx.work_dir,
                    capture_output=True, text=True, timeout=60,
                )
                self._send_json({
                    "stdout": result.stdout[:50000],
                    "stderr": result.stderr[:5000],
                    "exit_code": result.returncode,
                    "cwd": ctx.work_dir,
                })
            except subprocess.TimeoutExpired:
                self._send_json({"error": "Command timed out", "stdout": "", "stderr": ""})
            except Exception as e:
                self._send_json({"error": str(e)})

        def _send_json(self, data):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_header()
            self.wfile.write(json.dumps(data).encode())

        def log_message(self, format, *args):
            pass

    server = HTTPServer(("0.0.0.0", port), WebShellHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    with _webshell_lock:
        _webshell_servers[key] = server

    return {
        "status": "started",
        "port": port,
        "url": f"http://0.0.0.0:{port}/",
        "auth_token": auth_token or "(none)",
        "work_dir": ctx.work_dir,
    }


def _build_shell_html(port, auth_token):
    return f"""<!DOCTYPE html>
<html><head><title>Sandbox Shell :{port}</title>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{background:#0a0a0a;color:#00ff41;font-family:'Courier New',monospace;font-size:14px;height:100vh;display:flex;flex-direction:column}}
#header{{background:#111;padding:8px 12px;border-bottom:1px solid #333;font-size:12px;color:#888;display:flex;justify-content:space-between}}
#output{{flex:1;overflow-y:auto;padding:10px;white-space:pre-wrap;word-break:break-all;line-height:1.4}}
#output .err{{color:#ff5555}}
#output .exit{{color:#888;font-style:italic}}
#input-line{{display:flex;border-top:1px solid #333;background:#111}}
#prompt{{color:#00ff41;padding:8px 10px;font-size:14px;white-space:nowrap}}
#cmd{{flex:1;background:transparent;border:none;color:#00ff41;font-family:'Courier New',monospace;font-size:14px;padding:8px 0;outline:none}}
#cmd::placeholder{{color:#444}}
</style></head><body>
<div id="header"><span>Sandbox Web Shell :{port}</span><span id="cwd">/</span></div>
<div id="output"></div>
<div id="input-line"><span id="prompt">$&gt;</span><input id="cmd" type="text" placeholder="type command and press Enter" autofocus></div>
<script>
const output=document.getElementById('output'),cmd=document.getElementById('cmd'),cwd=document.getElementById('cwd');
const AUTH={json.dumps(auth_token)};
function addLine(t,c){const d=document.createElement('div');d.className=c||'';d.textContent=t;output.appendChild(d);output.scrollTop=output.scrollHeight}
async function exec(c){addLine('$ '+c);try{const r=await fetch('/exec',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:c,token:AUTH})});const j=await r.json();if(j.stdout)addLine(j.stdout);if(j.stderr)addLine(j.stderr,'err');if(j.cwd)cwd.textContent=j.cwd;if(j.exit_code!==undefined)addLine('exit: '+j.exit_code,'exit');if(j.error)addLine('ERROR: '+j.error,'err')}catch(e){addLine('NETWORK ERROR: '+e.message,'err')}}
cmd.addEventListener('keydown',e=>{{if(e.key==='Enter'){{const c=cmd.value;cmd.value='';exec(c)}}}});
</script></body></html>"""