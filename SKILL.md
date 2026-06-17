---
name: oh-coage
description: 使用可配置站点的 GPT-Image-2 API 生成图片，支持文生图和图生图。当用户说"生图"、"画图"、"生成图片"、"oh-coage"、"gpt-image"、"Image2 生图"、"帮我画"、"用 gpt 画"、"把这张图改成"、"参考这张图"等涉及 AI 图片生成或图片编辑的请求时触发此技能。首次使用时先做本地初始化：询问图片总保存目录、profile 名、站点 URL 和 API Key；Key 写入本机 Keychain，本地配置文件只保存非敏感信息。
---

# GPT-Image-2 图片生成

通过可配置站点的 GPT-Image-2 API 生成图片。模型固定为 `gpt-image-2`。支持：

- 文生图和图生图
- 同步返回和异步任务轮询
- 默认保存到用户指定目录
- 多 profile 管理与切换
- 自动 fallback 到备用 profile
- 运行日志记录
- API Key 写入本机 Keychain，不写入仓库或普通文本

## 强制流程

命中这个 skill 后，先执行下面的判定，不能跳步：

1. 检查本机是否已经完成 `oh-coage` 初始化
2. 如果**没有初始化**
   第一条用户可见回复必须直接进入初始化流程，按顺序询问这 4 个值：
   - 图片总保存到哪个文件夹
   - profile 名称是什么
   - 站点 URL 是什么
   - API Key 是什么
3. 在未完成初始化前：
   - 不要先去检查其他生图技能
   - 不要先去寻找其他图像生成路径
   - 不要先尝试调用别的图片工具兜底
   - 不要先告诉用户“我再看看有没有别的可用链路”
4. 只有在 `oh-coage` 明确不可用，或者用户明确要求不用它时，才允许转向其他生成路径

初始化优先级高于探索别的图片工具。用户已经触发了这个 skill，就应该先走这个 skill 自己的真实初始化链路。

## 配置后的优先级

只要 `oh-coage` 已经完成初始化并且当前 profile 可用，后续遇到图片生成或图片编辑请求时，应优先使用 `oh-coage`。

这条优先级规则适用于：

- 文生图
- 图生图
- 风格改图
- 参考图生成

在这种情况下：

- 不要先切去别的生图技能
- 不要先尝试其他图片工具
- 不要把 `oh-coage` 仅当作备选方案

只有在下面情况之一成立时，才允许不用 `oh-coage`：

1. `oh-coage` 当前未配置成功
2. `oh-coage` 当前运行失败且无法在当前回合内修复
3. 用户明确要求使用别的技能或别的生成路径

### 失败时的自动 fallback

当 `oh-coage` 已经配置成功时，生成链路应优先尝试当前 profile；如果遇到可重试错误，自动切到下一个可用 profile。

应视为可 fallback 的典型错误：

- `502`
- `503`
- `504`
- `408`
- `429`
- 网络超时
- 连接失败
- 连接重置

其中：

- `429`：先在当前 profile 上做短暂重试，再考虑切换
- `401` / `403`：直接判定该 profile 当前不可用

如果用户显式要求只用某一个 profile，或者显式禁用 fallback，才只跑单 profile。

### 未初始化时的第一条回复模板

如果检测到未初始化，第一条回复应尽量接近下面这个形式：

`当前会先初始化 oh-coage。我需要你提供 4 个值：1. 图片总保存目录 2. profile 名称 3. 站点 URL 4. API Key。`

不要在这条回复里插入额外的工具探索、替代方案说明或别的链路检查。

### 初始化完成后的确认模板

初始化完成后，下一条用户可见回复应尽量接近下面这个形式：

`oh-coage 已初始化完成。当前 profile 是 <profile 名称>。图片会先保存到总目录 <root_output_dir>，并在每次生成时自动新建时间子文件夹。现在开始按这条链路生成图片。`

不要在这条回复里重新展开别的技能探索，也不要把初始化结果说得含糊。

### fallback 全部失败后的回复模板

如果已经自动尝试完所有可用 profile，最终仍然失败，用户可见回复应尽量接近下面这个形式：

`oh-coage 已按顺序尝试完当前可用 profile，但都失败了。最后一次失败类型是 <错误类型/状态码>。现在需要你提供一条新的可用站点，或者允许我改用其他图片生成链路。`

只有所有候选 profile 都失败后，才使用这类回复。

## 首次使用初始化

如果用户第一次使用，或者脚本提示“尚未完成 oh-coage 初始化”，先不要直接生成图片，先按顺序询问用户：

1. 图片总保存到哪个文件夹
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

- 在用户指定目录中创建 `oh-coage-config.json`
- 在 `~/.oh-coage/state.json` 里记录当前配置文件路径
- 在 `~/.oh-coage/runs.jsonl` 中持续记录每次运行结果
- 把 API Key 写入本机 Keychain，service 为 `oh-coage`
- 把当前 profile 设为 active
- 后续每次出图时，都会在这个总目录下自动新建一个按时间命名的子文件夹，再把图片保存进去

注意：

- 本地配置文件只保存 `base_url`、`root_output_dir`、`keychain_account` 等非敏感字段
- 不把 key 写进仓库、README、Obsidian、日志或截图

## 依赖缺失处理

如果运行前发现缺少依赖，不要直接替用户安装，先询问用户是否允许补齐，并说明原因。

需要优先检查的依赖：

1. `Node.js`
2. macOS `security` 命令
3. Keychain 可用性

建议说明方式：

- 缺少 `Node.js`：此 skill 的 `setup.js` 和 `generate.js` 都依赖 Node.js 执行
- 缺少 `security`：此 skill 需要把 API Key 安全写入 Keychain，而不是明文写进配置文件
- Keychain 不可用：后续无法安全读取和切换多个 profile 的 key

只有在用户明确同意后，才继续补依赖或引导安装。

## 健康检查

当用户要求检查当前配置是否可用，或者你准备在多 profile 间排查问题时，使用：

```bash
node "$SKILL_DIR/scripts/setup.js" --health-check
```

默认检查：

- profile 是否启用
- 输出总目录是否可写
- `base_url` 格式是否合法
- Keychain 中是否能成功读取 key

如果用户明确允许做一次在线探测，再使用：

```bash
node "$SKILL_DIR/scripts/setup.js" --health-check --live
```

`--live` 会增加一次对 `base_url` 的低成本可达性检查。

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
- 将图片默认保存到该 profile 的总目录下，并自动创建时间命名子文件夹
- 在任务子目录内写入 `meta.json`
- 在 `~/.oh-coage/runs.jsonl` 追加本次运行日志

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

如果用户想删除某个 profile，运行：

```bash
node "$SKILL_DIR/scripts/setup.js" --delete-profile "backup"
```

如果用户想重命名某个 profile，运行：

```bash
node "$SKILL_DIR/scripts/setup.js" --rename-profile "old-name" --to "new-name"
```

如果用户想删除这个 skill 的本地配置和 Keychain 记录，运行：

```bash
node "$SKILL_DIR/scripts/setup.js" --uninstall-skill
```

说明：

- 该命令会删除本地 `state.json`
- 默认也会删除当前配置文件和相关 Keychain 记录
- 不会自动删除 skill 仓库目录本身
- 如果用户要保留配置文件或 Keychain，可加：
  - `--keep-config-file`
  - `--keep-keychain`

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
