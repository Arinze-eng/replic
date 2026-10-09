"""todo_tool.py — Manage task/todo list in the sandbox."""

import os
import json
import time
from datetime import datetime


def run(ctx, args):
    action = args.get("action", "list")
    todo_path = os.path.join(ctx.work_dir, ".agent_todos.json")

    todos = []
    if os.path.isfile(todo_path):
        try:
            with open(todo_path, "r") as f:
                todos = json.load(f)
        except (json.JSONDecodeError, IOError):
            todos = []

    if action == "add":
        title = args.get("title", "")
        if not title:
            return {"error": "No title provided", "todos": todos}
        priority = args.get("priority", "medium")
        todo = {
            "id": int(time.time()),
            "title": title,
            "status": "todo",
            "priority": priority,
            "created_at": datetime.now().isoformat(),
            "updated_at": datetime.now().isoformat(),
        }
        todos.append(todo)
        _save(todo_path, todos)
        return {"action": "added", "todo": todo, "total": len(todos), "todos": todos}

    elif action == "list":
        status_filter = args.get("status", "")
        if status_filter:
            filtered = [t for t in todos if t["status"] == status_filter]
        else:
            filtered = todos
        return {"action": "list", "total": len(filtered), "todos": filtered}

    elif action == "update":
        tid = args.get("id")
        if tid is None:
            return {"error": "No id provided", "todos": todos}
        for t in todos:
            if t["id"] == tid:
                if args.get("title"):
                    t["title"] = args["title"]
                if args.get("status"):
                    t["status"] = args["status"]
                if args.get("priority"):
                    t["priority"] = args["priority"]
                t["updated_at"] = datetime.now().isoformat()
                _save(todo_path, todos)
                return {"action": "updated", "todo": t, "total": len(todos), "todos": todos}
        return {"error": f"Todo id {tid} not found", "todos": todos}

    elif action == "delete":
        tid = args.get("id")
        if tid is None:
            return {"error": "No id provided", "todos": todos}
        before = len(todos)
        todos = [t for t in todos if t["id"] != tid]
        if len(todos) < before:
            _save(todo_path, todos)
            return {"action": "deleted", "total": len(todos), "todos": todos}
        return {"error": f"Todo id {tid} not found", "todos": todos}

    elif action == "clear":
        _save(todo_path, [])
        return {"action": "cleared", "total": 0, "todos": []}

    return {"error": f"Unknown action: {action}", "todos": todos}


def _save(path, todos):
    with open(path, "w") as f:
        json.dump(todos, f, indent=2)