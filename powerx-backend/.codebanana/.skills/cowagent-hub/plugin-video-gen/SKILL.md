---
name: plugin-video-gen
description: AI视频生成 - 根据用户的输入一键生成视频，输入的参数为用户提供的视频生成需求，要尽可能和用户原始需求保持一致。当需要执行该插件提供的功能时可使用此技能。
metadata:
  requires:
    bins: ["curl"]
    env: ["LINKAI_API_KEY"]
---

# AI视频生成

## Setup

This skill requires a LinkAI API Key.

1. Get your API Key from [LinkAI Console](https://link-ai.tech/console/interface)
2. Set the environment variable: `export LINKAI_API_KEY=Link_xxxxxxxxxxxx`

## Skill Args Definition

```json
{
    "type": "function",
    "function": {
        "name": "plugin-video-gen",
        "description": "AI视频生成 - 根据用户的输入一键生成视频，输入的参数为用户提供的视频生成需求，要尽可能和用户原始需求保持一致。当需要执行该插件提供的功能时可使用此技能。",
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "提示词"
                },
                "image_url": {
                    "type": "string",
                    "description": "参考图片url"
                },
                "video_url": {
                    "type": "string",
                    "description": "参考视频url，Seedance 2.0支持"
                },
                "audio_url": {
                    "type": "string",
                    "description": "参考音频url，Seedance 2.0支持"
                },
                "duration": {
                    "type": "string",
                    "description": "视频时长(秒)，Seedance 2.0: 4~15秒，即梦/可灵: 5或10秒，默认5秒",
                    "default": "5"
                },
                "model": {
                    "type": "string",
                    "description": "模型选择",
                    "default": "jimeng_t2v_v30",
                    "enum": [
                        "jimeng_t2v_v30",
                        "jimeng_ti2v_v30_pro",
                        "kling-video-o1",
                        "doubao-seedance-2-0",
                        "doubao-seedance-2-0-fast",
                        "veo_3_1",
                        "sora-2"
                    ]
                },
                "ratio": {
                    "type": "string",
                    "description": "宽高比，文生视频时支持，可填写16:9, 1:1, 9:16",
                    "default": "16:9"
                },
                "size": {
                    "type": "string",
                    "description": "视频大小，seedance支持480P、720P，即梦支持720P、1080P",
                    "default": "720P"
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
    "code": "video-gen",
    "args": {
        "prompt": "<提示词>",
        "image_url": "<参考图片url>",
        "video_url": "<参考视频url，Seedance 2.0支持>",
        "audio_url": "<参考音频url，Seedance 2.0支持>",
        "duration": "5",
        "model": "jimeng_t2v_v30",
        "ratio": "16:9",
        "size": "720P"
    }
}'
```

> 建议设置超时时间为 600s。

**Response**:

```json
{
    "success": true,
    "code": 200,
    "message": "success",
    "data": "<execution result>"
}
```
