---
name: gpt-image
description: 使用 DragonCode GPT-Image-2 API 生成图片。当用户说"生图"、"画图"、"生成图片"、"gpt-image"、"Image2 生图"、"帮我画"、"用 gpt 画"等涉及 AI 图片生成的请求时触发此技能。首次使用会引导配置 API Key，后续直接生成。
---

# GPT-Image-2 图片生成

通过 DragonCode 的 GPT-Image-2 API 生成图片。异步任务模式：提交 → 轮询 → 返回图片链接。

## 前置检查

每次触发时按顺序检查：

### 1. 检查 Node.js

运行 `node -v`，如果失败则提示用户：

> 此技能需要 Node.js 环境，请先安装：https://nodejs.org/
> 或参考 DragonCode 文档中的 Node.js 环境安装指南。

### 2. 检查 API Key 配置

配置文件路径：`~/.dragoncode/config.json`

检查文件是否存在且 `api_key` 字段非空。如果不存在，引导用户执行一条命令完成配置：

**macOS / Linux：**
```bash
mkdir -p ~/.dragoncode && echo '{"api_key":"这里粘贴你的Key"}' > ~/.dragoncode/config.json
```

**Windows (PowerShell)：**
```powershell
mkdir -Force "$env:USERPROFILE\.dragoncode" | Out-Null; '{"api_key":"这里粘贴你的Key"}' | Set-Content "$env:USERPROFILE\.dragoncode\config.json"
```

告知用户 API Key 在这里创建：https://dragoncode.codes/keys

用户配置完成后才继续生成流程。已配置过的用户直接跳到生成步骤。

## 生成流程

读取配置后调用脚本：

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "用户的提示词" \
  --size "1:1" \
  --resolution "2k"
```

脚本自动完成：提交任务 → 轮询状态 → stdout 输出图片链接。

### 参数选择

根据用户需求选择参数：

- **size（比例）**：默认 `1:1`。横屏/宽屏 → `16:9`，竖屏/手机壁纸 → `9:16`，海报 → `2:3`
- **resolution（分辨率）**：默认 `2k`。用户说高清/4K → `4k`，快速/省钱 → `1k`

### 4K 比例限制

4K 仅支持：`16:9`、`9:16`、`2:1`、`1:2`、`21:9`、`9:21`。
脚本会自动将不兼容的 4K 请求降为 2K。

### 所有支持的比例

`auto`、`1:1`、`3:2`、`2:3`、`4:3`、`3:4`、`5:4`、`4:5`、`16:9`、`9:16`、`2:1`、`1:2`、`21:9`、`9:21`

## 输出

脚本成功后输出图片 URL，展示给用户并告知可直接在浏览器打开。
