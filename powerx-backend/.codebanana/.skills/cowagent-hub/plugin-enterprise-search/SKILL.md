---
name: plugin-enterprise-search
description: 企业工商信息查询 - 支持查询企业基本信息、工商信息、投资信息、资质证书、股权信息等。当需要执行该插件提供的功能时可使用此技能。
metadata:
  requires:
    bins: ["curl"]
    env: ["LINKAI_API_KEY"]
---

# 企业工商信息查询

## Setup

This skill requires a LinkAI API Key.

1. Get your API Key from [LinkAI Console](https://link-ai.tech/console/interface)
2. Set the environment variable: `export LINKAI_API_KEY=Link_xxxxxxxxxxxx`

## Skill Args Definition

```json
{
    "type": "function",
    "function": {
        "name": "plugin-enterprise-search",
        "description": "企业工商信息查询 - 支持查询企业基本信息、工商信息、投资信息、资质证书、股权信息等。当需要执行该插件提供的功能时可使用此技能。",
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
    "code": "enterprise-search",
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
