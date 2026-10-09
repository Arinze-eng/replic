---
name: plugin-bilibili-search
description: B站视频搜索 - 根据关键词搜索bilibili网站中的视频。当需要执行该插件提供的功能时可使用此技能。
metadata:
  requires:
    bins: ["curl"]
    env: ["LINKAI_API_KEY"]
---

# B站视频搜索

## Setup

This skill requires a LinkAI API Key.

1. Get your API Key from [LinkAI Console](https://link-ai.tech/console/interface)
2. Set the environment variable: `export LINKAI_API_KEY=Link_xxxxxxxxxxxx`

## Skill Args Definition

```json
{
    "type": "function",
    "function": {
        "name": "plugin-bilibili-search",
        "description": "B站视频搜索 - 根据关键词搜索bilibili网站中的视频。当需要执行该插件提供的功能时可使用此技能。",
        "parameters": {
            "type": "object",
            "properties": {
                "input": {
                    "type": "string",
                    "description": "用户的请求内容"
                }
            },
            "required": [
                "input"
            ]
        }
    }
}
```

## Usage

**Example**:

```bash
curl -X POST "https://api.link-ai.tech/v1/plugin/execute" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LINKAI_API_KEY" \
  -d '{
    "code": "bilibili-search",
    "input": "用户请求内容"
}'
```

> 建议设置超时时间为 120s。

**Response**:

```json
{
    "success": true,
    "code": 200,
    "message": "success",
    "data": "<execution result>"
}
```
