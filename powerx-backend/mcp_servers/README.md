# Free MCP Servers — Git & Sequential Thinking

Both servers are 100% free. No API keys. No accounts.

---

## Install

```bash
pip install -r requirements.txt
```

---

## Run

```bash
python git_server.py
python sequential_thinking_server.py
```

---

## Claude Desktop Config

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "git": {
      "command": "python",
      "args": ["/path/to/git_server.py"]
    },
    "sequential-thinking": {
      "command": "python",
      "args": ["/path/to/sequential_thinking_server.py"]
    }
  }
}
```

---

## Git Server Tools (12 tools)

| Tool | What it does |
|---|---|
| `git_status` | Show working tree status |
| `git_log` | Show recent commit history |
| `git_diff` | Show changes (staged or unstaged) |
| `git_branches` | List all branches |
| `git_checkout` | Switch or create a branch |
| `git_add` | Stage files for commit |
| `git_commit` | Commit staged changes |
| `git_show` | Show details of a specific commit |
| `git_search_commits` | Search commits by keyword |
| `git_stash` | Save or pop stashed changes |
| `git_init` | Initialize a new git repo |
| `git_clone` | Clone a remote repository |

---

## Sequential Thinking Server Tools (7 tools)

| Tool | What it does |
|---|---|
| `think_step` | Add one reasoning step to a sequence |
| `think_sequence` | Submit a full list of thoughts at once |
| `get_sequence` | Retrieve a thought sequence by ID |
| `list_sequences` | List all active sequences |
| `conclude_sequence` | Mark a sequence done with a conclusion |
| `branch_sequence` | Fork a sequence to explore an alternative |
| `clear_sequence` | Delete a sequence from memory |

---

## Requirements
- Python 3.10+
- `mcp` library (for both)
- `gitpython` (for git_server.py only)
- Sequential thinking has zero extra dependencies
