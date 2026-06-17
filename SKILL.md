---
name: gpt-image
description: 使用可配置站点的 GPT-Image-2 API 生成图片，支持文生图和图生图。当用户说"生图"、"画图"、"生成图片"、"gpt-image"、"Image2 生图"、"帮我画"、"用 gpt 画"、"把这张图改成"、"参考这张图"等涉及 AI 图片生成或图片编辑的请求时触发此技能。首次使用时先做本地初始化：询问图片保存目录、profile 名、站点 URL 和 API Key；Key 写入本机 Keychain，本地配置文件只保存非敏感信息。
---

# GPT-Image-2 图片生成

通过可配置站点的 GPT-Image-2 API 生成图片。模型固定为 `gpt-image-2`。支持：

- 文生图和图生图
- 同步返回和异步任务轮询
- 默认保存到用户指定目录
- 多 profile 管理与切换
- API Key 写入本机 Keychain，不写入仓库或普通文本

## 首次使用初始化

如果用户第一次使用，或者脚本提示“尚未完成 images2-gen 初始化”，先不要直接生成图片，先按顺序询问用户：

1. 图片保存到哪个文件夹
2. profile 名称是什么
3. 站点 URL 是什么
4. API Key 是什么

然后运行：

```bash
node "$SKILL_DIR/scripts/setup.js" \
  --output-dir "/absolute/path/to/save" \
  --profile "default" \
  --base-url "https://your-image-site.example/v1" \
  --api-key "YOUR_KEY" \
  --activate
```

初始化行为：

- 在用户指定目录中创建 `images2-gen-config.json`
- 在 `~/.images2-gen/state.json` 里记录当前配置文件路径
- 把 API Key 写入本机 Keychain，service 为 `images2-gen`
- 把当前 profile 设为 active

注意：

- 本地配置文件只保存 `base_url`、`output_dir`、`keychain_account` 等非敏感字段
- 不把 key 写进仓库、README、Obsidian、日志或截图

## 后续生成流程

初始化完成后，直接调用：

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "用户的提示词" \
  --size "1:1" \
  --resolution "2k"
```

脚本会自动：

- 读取当前 active profile
- 从 Keychain 读取该 profile 的 API Key
- 调用对应 `base_url`
- 将图片默认保存到该 profile 的 `output_dir`

如果用户明确要切换 profile，可在生成时指定：

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --profile "backup" \
  --prompt "用户的提示词"
```

如果用户想长期切换当前默认 profile，运行：

```bash
node "$SKILL_DIR/scripts/setup.js" --activate-profile "backup"
```

如果用户想查看已有 profile，运行：

```bash
node "$SKILL_DIR/scripts/setup.js" --list
```

如果用户想新增一个 profile，重复运行初始化命令，但换一个 `--profile` 名和对应的 `base_url` / `api_key` 即可。

## 图生图

用户提供参考图片时，加上 `--image-url`：

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "把这张图改成水彩风格" \
  --image-url "https://example.com/photo.jpg"
```

- 可重复传入 `--image-url` 提供多张图
- 如果用户给的是本地文件路径，先读文件并转为 base64 data URI 再传入

## 参数选择

- `size` 默认 `1:1`
- 宽屏图优先 `16:9`
- 竖屏或手机壁纸优先 `9:16`
- 海报优先 `2:3`
- `resolution` 默认 `2k`
- 用户说高清或 4K 时优先 `4k`
- 用户说快速或省钱时优先 `1k`

4K 仅支持：`16:9`、`9:16`、`2:1`、`1:2`、`21:9`、`9:21`。不兼容时脚本会自动降为 `2k`。

## 输出

- 默认输出：本地图片文件路径
- 如果用户显式传了 `--output`，保存到指定文件
- 如果用户不想落地到本地，可自行传空的输出覆盖逻辑并只取 URL，但默认策略应优先保存本地，便于用户直接查看成果
