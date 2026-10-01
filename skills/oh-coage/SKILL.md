---
name: oh-coage
description: 使用可配置站点的 GPT-Image 系列 API 生成图片，支持文生图和图生图，并可在 gpt-image-2 / gpt-image-2.5-sunburst / gpt-image-2.5-flare 三个内置模型间切换或自定义模型。当用户说"生图"、"画图"、"生成图片"、"oh-coage"、"gpt-image"、"Image2 生图"、"帮我画"、"用 gpt 画"、"用 2.5 画"、"切换模型"、"换模型"、"换个模型"、"改成 xxx 模型"、"使用 xxx 模型"、"有哪些模型"、"把这张图改成"、"参考这张图"等涉及 AI 图片生成、图片编辑或模型切换的请求时触发此技能。首次使用时先做本地初始化：收集图片总保存目录、profile 名、站点 URL 和 API Key；支持聊天问答和可视化表单两种初始化方式；Key 写入本机 Keychain，本地配置文件只保存非敏感信息。
---

# GPT-Image 图片生成

通过可配置站点的 GPT-Image 系列 API 生成图片。默认模型 `gpt-image-2`，另有 2 个 2.5 系列模型可选，也支持用户自定义模型。支持：

- 文生图和图生图
- 模型选择：3 个内置 + 自定义
- 同步返回和异步任务轮询
- 默认保存到用户指定目录
- 多 profile 管理与切换
- 自动 fallback 到备用 profile
- 运行日志记录
- API Key 写入本机 Keychain，不写入仓库或普通文本

## 脚本位置

本 skill 是自包含目录，`SKILL.md`、`scripts/`、`assets/` 三者同级：

```text
<skill 目录>/
├── SKILL.md
├── scripts/
│   ├── config-store.js
│   ├── generate.js
│   ├── resolve-output-dir.js
│   └── setup.js
└── assets/
    └── oh-coage-init-form.html
```

本文所有命令里的 `$SKILL_DIR` 都指这个目录。如果宿主把 `$SKILL_DIR` 设成了别的值，请改用**本 `SKILL.md` 实际所在目录**。

## 模型选择

内置 3 个模型：

| 短名 | model ID |
|---|---|
| `image-2` | `gpt-image-2`（默认） |
| `image-2.5-sunburst` | `gpt-image-2.5-sunburst` |
| `image-2.5-flare` | `gpt-image-2.5-flare` |

规则：

1. **不指定就用当前模型。** 当前模型存在配置文件里，用 `setup.js --model` 切换后持续生效，直到用户再次切换。
2. **单次覆盖用 `--model`**，不改动持久配置。
3. **`2.5` / `image-2.5` / `gpt-image-2.5` 是歧义输入。** 脚本会直接报错并列出两个候选。用户只说「用 2.5 画」时，你要先问清是 `sunburst` 还是 `flare`，**不要替用户猜**——两者是不同档位，猜错会白花一次配额。
4. **也可以直接传原始 model ID**，例如 `--model gpt-image-2.5-flare`。

查看可用模型与当前模型：

```bash
node "$SKILL_DIR/scripts/setup.js" --list-models
```

切换当前模型（持久生效）：

```bash
node "$SKILL_DIR/scripts/setup.js" --model "image-2.5-flare"
```

单次指定：

```bash
node "$SKILL_DIR/scripts/generate.js" --model "image-2.5-sunburst" --prompt "用户的提示词"
```

### 用户想换模型时

用户说「切换模型」「换模型」「换个模型」「改成 xxx 模型」「使用 xxx 模型」「以后都用 xxx 画」「有哪些模型」这类话时，按下面三步走。

**第 1 步：是「改默认」还是「只这一次」**

- 「以后都用 / 默认用 / 换成 / 切换成 / 改用 xxx」→ 改默认，用 `setup.js --model`（持久生效）
- 「这次 / 这张 / 用 xxx 画这一张」→ 只这一次，用 `generate.js --model`（不改配置）

拿不准时按**持久切换**处理，并在回复里说明「已切换默认模型」。

**第 2 步：用户有没有点名模型**

- **点名了就不要再问**，直接切。允许只叫后半截名字，脚本会唯一匹配：
  - 「用 flare 画」→ `--model flare` → `gpt-image-2.5-flare`
  - 「用 sunburst」→ `--model sunburst` → `gpt-image-2.5-sunburst`
  - 完整短名（`image-2.5-flare`）和完整 model ID（`gpt-image-2.5-flare`）也都接受
- **只说要换、没点名**（「换个模型」）→ 先列出来让用户选，不要擅自替他选：

  ```bash
  node "$SKILL_DIR/scripts/setup.js" --list-models
  ```

  把结果整理成选项发给他，等选定后再执行切换。
- **说了「2.5」这种不完整的** → 必须问清是 `sunburst` 还是 `flare`。脚本会直接报错并列出两个候选，你要把这个选择转达给用户，**不要自己猜**。
- **拼错或不存在** → 脚本会报错并列出全部可用模型，把可选值转达给用户重选。

**第 3 步：报结果**

切换完成后告诉用户当前模型，**用完整 model ID**（例如 `gpt-image-2.5-flare`），不要只说短名或「2.5」。

**两个容易混的地方**

- 「把这张图改成水彩风格」是**改图**，走 `generate.js --image-url`；「把模型改成 flare」才是换模型。靠宾语区分。
- 换模型默认是**全局**的，影响之后所有生成。用户说「只让某个站点 / 某个 profile 用这个模型」时，用 `--profile-model`，不要用 `--model`。

### 模型优先级

某个候选 profile 实际用哪个模型，顺序是：

1. `generate.js --model`（本次显式指定）
2. 该 profile 的 `model` 字段（`setup.js --profile-model` 固定）
3. 配置里的 `current_model`（`setup.js --model` 切换的全局值）
4. 默认 `image-2`

也就是说 fallback 链上**每个 profile 各用各的**：固定了就用固定的，没固定才跟随全局。`--list` 能看到哪些 profile 固定了模型。

如果某个 profile 固定了一个已不存在的模型，生成时它会被跳过并打印提示，不会中断整轮。

### 用户要自定义模型时

必须**先向用户问清该站点要求的准确 model ID 字符串**，再执行：

```bash
node "$SKILL_DIR/scripts/setup.js" --add-model "my-model" --model-id "vendor-model-id" --label "说明"
```

不要自己编一个 model ID，也不要用看起来像的字符串凑数。缺少 `--model-id` 时脚本会拒绝执行并给出提示。删除自定义模型用 `--delete-model`；内置模型不可删除。

### 给某个站点固定模型

当用户说「这个站点只能用某个模型」时，用它而不是全局切换：

```bash
node "$SKILL_DIR/scripts/setup.js" --profile-model "image-2.5-flare" --profile "main"
```

初始化时也可以带 `--profile-model` 一起固定。取消固定传 `none`。

注意：`setup.js --model` 和初始化参数可以同时给（会先初始化、再切换全局模型），但 `--model` 是**全局**开关，不要用它来表达「只给这个站点固定」。

## 强制流程

命中这个 skill 后，先执行下面的判定，不能跳步：

1. 检查本机是否已经完成 `oh-coage` 初始化
2. 如果**没有初始化**，第一条用户可见回复必须直接进入初始化流程，不要先做别的探索
3. 初始化方式按环境能力二选一，**先判定能力，再选路径**，不要"先试表单、失败了再回退"：
   - **增强路径**：仅当环境同时支持 inline HTML 渲染（`visualize` 类能力）**且**存在 `window.openai.sendFollowUpMessage` 时，才渲染表单
   - **默认路径**：以上任一条件不满足时，直接用文字询问那 4 个值
4. 在未完成初始化前：
   - 不要先去检查其他生图技能
   - 不要先去寻找其他图像生成路径
   - 不要先尝试调用别的图片工具兜底
   - 不要先告诉用户“我再看看有没有别的可用链路”
5. 只有在 `oh-coage` 明确不可用，或者用户明确要求不用它时，才允许转向其他生成路径

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

- `500`
- `502`
- `503`
- `504`
- `408`
- `429`
- 网络超时
- 连接失败
- 连接重置

其中：

- 以上可重试错误会先在当前 profile 上退避重试一次，仍失败才切换 profile
- `401` / `403`：不重试，直接判定该 profile 当前不可用并切换
- Keychain 读不到 key：只跳过该 profile，不中断整轮
- `base_url` 协议不是 `http`/`https`：尝试前就跳过该 profile

如果用户显式要求只用某一个 profile，或者显式禁用 fallback，才只跑单 profile。

### 初始化方式一：文字询问（默认路径）

这是所有环境都必须可用的基线。第一条回复应尽量接近下面这个形式：

`当前会先初始化 oh-coage。我需要你提供 4 个值：1. 图片总保存目录 2. profile 名称 3. 站点 URL 4. API Key。`

不要在这条回复里插入额外的工具探索、替代方案说明或别的链路检查。

### 初始化方式二：可视化表单（仅限支持的环境）

只有在当前环境确实支持 inline HTML 渲染且存在 `window.openai.sendFollowUpMessage` 时才走这条路径。不要把它当作默认路径：在普通 CLI / 终端类 agent 里它不可用，强行渲染只会浪费一轮。

1. 运行 `node "$SKILL_DIR/scripts/resolve-output-dir.js"` 得到默认保存目录
2. 使用 `assets/oh-coage-init-form.html`，按宿主的 inline HTML 流程渲染，并把 `outputDir` 预填为上一步的结果
3. 如果解析结果是项目根目录，把表单根节点的 `data-has-project` 设为 `true`；否则保持 `false`，并把保存目录预填为桌面
4. 第一条回复只引导用户填表并展示表单，不要先用文字逐项询问，也不要把任何字段预填成真实密钥

表单提交后会发来一条包含 `OH_COAGE_INIT_FORM_SUBMISSION` 标记的结构化消息。收到这条消息后：

1. 直接解析其中的 `outputDir`、`profile`、`baseUrl`、`apiKey`、`model`
2. 用 `$SKILL_DIR/scripts/setup.js` 完成本地初始化，加上 `--activate`，并把 `model` 通过 `--model` 一起传入（`setup.js` 支持初始化和 `--model` 同时给，会先初始化再切换全局模型）
3. 不要在命令输出、日志、回复或截图中复述 `apiKey`
4. 初始化后运行一次 `--health-check`，再报告 profile、模型、保存目录和检查结果

保存目录字段默认已经预填。用户可以直接使用当前项目目录或桌面，也可以手动修改该字段；不要在首次初始化时额外打开系统文件夹选择器。

### 初始化完成后的确认模板

初始化完成后，下一条用户可见回复应尽量接近下面这个形式：

`oh-coage 已初始化完成。当前 profile 是 <profile 名称>。图片会先保存到总目录 <root_output_dir>，并在每次生成时自动新建时间子文件夹。现在开始按这条链路生成图片。`

不要在这条回复里重新展开别的技能探索，也不要把初始化结果说得含糊。

### fallback 全部失败后的回复模板

如果已经自动尝试完所有可用 profile，最终仍然失败，用户可见回复应尽量接近下面这个形式：

`oh-coage 已按顺序尝试完当前可用 profile，但都失败了。最后一次失败类型是 <错误类型/状态码>。现在需要你提供一条新的可用站点，或者允许我改用其他图片生成链路。`

只有所有候选 profile 都失败后，才使用这类回复。

## 首次使用初始化

如果用户第一次使用，或者脚本提示“尚未完成 oh-coage 初始化”，先按上面的方式判定初始化路径，不要直接生成图片。无论走哪条路径，最终都需要这 4 个值：

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

首次初始化时，macOS 可能弹出 Keychain 授权窗口：

- 这是正常行为，因为需要把真实 API Key 写入系统 Keychain
- 用户需要在弹窗里点“允许”
- 如果点了“拒绝”或直接关掉弹窗，这次初始化会失败；重新执行一次 `setup.js` 即可

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
- 按上面的模型优先级决定用哪个模型（`--model` 可单次覆盖）
- 从 Keychain 读取该 profile 的 API Key
- 调用对应 `base_url`
- 将图片默认保存到该 profile 的总目录下，并自动创建时间命名子文件夹
- 在任务子目录内写入 `meta.json`
- 在 `~/.oh-coage/runs.jsonl` 追加本次运行日志

如果接口返回 `task_id`，脚本会自动回收异步任务结果。回收节奏是 `5s -> 10s -> 20s -> 30s -> 60s -> 60s -> 60s`，之后继续以 `60s` 间隔查询，直到达到 5 分钟总超时。

任务终态不只认 `completed` / `failed`，也认 `succeeded`、`done`、`finished`、`error`、`canceled` 等常见写法；轮询期间遇到可重试错误会在同一任务上重试，不会立刻放弃整个任务。

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
- 默认**保留** `~/.oh-coage/runs.jsonl`，要一并清掉需加 `--purge-logs`
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
- `--image-url` 支持 URL、base64 data URI 和本地图片文件路径
- 如果用户给的是本地文件路径，可以直接传给脚本；脚本会自动读取文件并转为 base64 data URI 上传
- 支持的本地图片格式：`png`、`jpg`、`jpeg`、`webp`、`gif`

## 参数选择

- `size` 默认 `1:1`
- 宽屏图优先 `16:9`
- 竖屏或手机壁纸优先 `9:16`
- 海报优先 `2:3`
- `resolution` 默认 `2k`
- 用户说高清或 4K 时优先 `4k`
- 用户说快速或省钱时优先 `1k`
- `model` 不传就用当前模型；用户点名某个模型时才传 `--model`

默认模型是 `gpt-image-2`。用户没有提模型时，不要主动换成 2.5 系列——2.5 是不同档位，可能更贵。只有用户明确要求时才切换或指定。

4K 仅支持：`16:9`、`9:16`、`2:1`、`1:2`、`21:9`、`9:21`。不兼容时脚本会自动降为 `2k`。

## 输出

- 默认输出：本地图片文件路径
- 如果用户显式传了 `--output`，保存到指定文件
- 如果用户不想落地到本地，可自行传空的输出覆盖逻辑并只取 URL，但默认策略应优先保存本地，便于用户直接查看成果
