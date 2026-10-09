---
name: plugin-gpt-image
description: GPT Image 图像生成 - 图像生成工具，只有当用户明确提出需要生成图片或修改图片时才使用，如果只是文本创作类的请求则不要选择该工具。输入的参数为用户提供的图片生成描述，需要保持完全一致，不要有任何修改。当需要执行该插件提供的功能时可使用此技能。
metadata:
  requires:
    bins: ["curl"]
    env: ["LINKAI_API_KEY"]
---

# GPT Image 图像生成

## Setup

This skill requires a LinkAI API Key.

1. Get your API Key from [LinkAI Console](https://link-ai.tech/console/interface)
2. Set the environment variable: `export LINKAI_API_KEY=Link_xxxxxxxxxxxx`

## Skill Args Definition

```json
{
    "type": "function",
    "function": {
        "name": "plugin-gpt-image",
        "description": "GPT Image 图像生成 - 图像生成工具，只有当用户明确提出需要生成图片或修改图片时才使用，如果只是文本创作类的请求则不要选择该工具。输入的参数为用户提供的图片生成描述，需要保持完全一致，不要有任何修改。当需要执行该插件提供的功能时可使用此技能。",
        "parameters": {
            "type": "object",
            "properties": {
                "model": {
                    "type": "string",
                    "description": "模型版本，可选 gpt-image-2 或 gpt-image-1，默认 gpt-image-2",
                    "default": "gpt-image-2"
                },
                "prompt": {
                    "type": "string",
                    "description": "提示词"
                },
                "image_url": {
                    "type": "string",
                    "description": "原始图片url(选填，改图时需要)"
                },
                "quality": {
                    "type": "string",
                    "description": "图片质量(选填)，可选 low/medium/high，默认 low",
                    "default": "low"
                },
                "size": {
                    "type": "string",
                    "description": "图片分辨率档位(选填)，可选 auto/1K/2K/4K，默认 1K",
                    "default": "1K"
                },
                "aspect_ratio": {
                    "type": "string",
                    "description": "图片比例(选填)，可选 1:1/3:2/2:3/16:9/9:16，配合 size 使用"
                }
            },
            "required": [
                "prompt"
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
    "code": "gpt-image",
    "args": {
        "model": "gpt-image-2",
        "prompt": "<提示词>",
        "image_url": "<原始图片url(选填，改图时需要)>",
        "quality": "low",
        "size": "1K",
        "aspect_ratio": "<图片比例(选填)，可选 1:1/3:2/2:3/16:9/9:16，配合 size 使用>"
    }
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
