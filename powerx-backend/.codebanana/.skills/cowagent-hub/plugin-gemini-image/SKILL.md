---
name: plugin-gemini-image
description: Nano Banana图像生成 - 基于gemini 模型的图片生成和编辑工具，当用户需要生成、编辑或合成图片时选择该工具，如果只是文本创作类的请求则不要选择该工具。输入的参数为用户提供的画图描述，需要保持完全一致，不要有任何修改。当需要执行该插件提供的功能时可使用此技能。
metadata:
  requires:
    bins: ["curl"]
    env: ["LINKAI_API_KEY"]
---

# Nano Banana图像生成

## Setup

This skill requires a LinkAI API Key.

1. Get your API Key from [LinkAI Console](https://link-ai.tech/console/interface)
2. Set the environment variable: `export LINKAI_API_KEY=Link_xxxxxxxxxxxx`

## Skill Args Definition

```json
{
    "type": "function",
    "function": {
        "name": "plugin-gemini-image",
        "description": "Nano Banana图像生成 - 基于gemini 模型的图片生成和编辑工具，当用户需要生成、编辑或合成图片时选择该工具，如果只是文本创作类的请求则不要选择该工具。输入的参数为用户提供的画图描述，需要保持完全一致，不要有任何修改。当需要执行该插件提供的功能时可使用此技能。",
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "提示词"
                },
                "image_url": {
                    "type": "string",
                    "description": "原始图片url(选填，改图时需要)"
                },
                "version": {
                    "type": "string",
                    "description": "模型版本 (v1为基础版本，pro为v1的增强版，v2针对速度进行优化)",
                    "default": "v2",
                    "enum": [
                        "v1",
                        "pro",
                        "v2"
                    ]
                },
                "image_size": {
                    "type": "string",
                    "description": "图片尺寸，支持填写 1K、2K、4K",
                    "default": "1K"
                },
                "ratio": {
                    "type": "string",
                    "description": "宽高比，不填则自动识别，可填写1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9"
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
    "code": "gemini-image",
    "args": {
        "prompt": "<提示词>",
        "image_url": "<原始图片url(选填，改图时需要)>",
        "version": "v2",
        "image_size": "1K",
        "ratio": "<宽高比，不填则自动识别，可填写1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9>"
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
