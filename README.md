# GPT-Image-2 生图技能

DragonCode GPT-Image-2 图片生成技能，适用于 Claude Code。

## 安装

在 Claude Code 中执行：

```
/install-skill https://github.com/bozhouDev/images2-gen
```

## 首次配置

安装后首次使用时，需要配置 API Key：

1. 前往 [https://dragoncode.codes/keys](https://dragoncode.codes/keys) 创建 API Key
2. 执行以下命令将 Key 写入配置文件：

**macOS / Linux：**

```bash
mkdir -p ~/.dragoncode && echo '{"api_key":"这里粘贴你的Key"}' > ~/.dragoncode/config.json
```

**Windows (PowerShell)：**

```powershell
mkdir -Force "$env:USERPROFILE\.dragoncode" | Out-Null; '{"api_key":"这里粘贴你的Key"}' | Set-Content "$env:USERPROFILE\.dragoncode\config.json"
```

配置一次后续不再需要。

## 使用

直接对 Claude 说：

- "帮我生成一张猫咪的图片"
- "用 gpt-image 画一个赛博朋克风格的城市"
- "Image2 生图：一只在月球上的柴犬"

技能会自动调用 GPT-Image-2 API 生成图片并返回链接。

## 依赖

- Node.js（如未安装，技能会提示你前往 [nodejs.org](https://nodejs.org/) 安装）

## 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| size | 1:1 | 图片比例，支持 `1:1` `16:9` `9:16` `2:3` `3:2` 等 |
| resolution | 2k | 分辨率档位：`1k` `2k` `4k` |

> 4K 仅支持 `16:9` `9:16` `2:1` `1:2` `21:9` `9:21` 比例，其他比例会自动降为 2K。
