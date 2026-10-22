---
name: oh-coage
description: 使用可配置站点或官方接口生成图片，支持 OpenAI 兼容、Gemini（Nano Banana）与 Grok Imagine 三类模型，默认全部走 OpenAI 兼容生图接口，也可按用户要求切换到 Gemini / Grok 官方接口。支持文生图、图生图、模型切换、按 URL + Key 拉取可用模型、多 profile 保存与 fallback。当用户说"生图"、"画图"、"生成图片"、"oh-coage"、"gpt-image"、"Image2 生图"、"帮我画"、"用 gpt 画"、"用 2.5 画"、"用 banana 画"、"用 grok 画"、"切换模型"、"换模型"、"换个模型"、"改成 xxx 模型"、"使用 xxx 模型"、"有哪些模型"、"拉取模型"、"用官方接口"、"把这张图改成"、"参考这张图"等涉及 AI 图片生成、图片编辑、模型或接口切换的请求时触发此技能。生成结果应直接在对话中展示图片，兼容接口返回 URL 与 base64 两种情况。首次使用时先做本地初始化：收集 profile 名、站点 URL 和 API Key（图片目录非必填，自动落到项目目录或桌面）；支持聊天问答和可视化表单两种初始化方式；Key 写入本机 Keychain，本地配置文件只保存非敏感信息。
---

# 图片生成

通过可配置站点或官方接口生成图片。默认模型 `gpt-image-2`，另有 2 个 2.5 系列模型；同时支持 Gemini（Nano Banana）和 Grok Imagine 模型。支持：

- 文生图和图生图
- 三类模型族：`openai`（image）/ `gemini`（banana）/ `grok`
- 两种接口协议：默认 `openai` 兼容接口，可选 `official` 官方接口
- 用站点 URL + Key 拉取该站点真实支持的模型
- 同步返回和异步任务轮询
- 默认保存到用户指定目录
- 多 profile 管理与切换
- 自动 fallback 到同一模型族内的备用 profile
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
│   ├── models.js
│   ├── providers.js
│   ├── resolve-output-dir.js
│   └── setup.js
└── assets/
    └── oh-coage-init-form.html
```

本文所有命令里的 `$SKILL_DIR` 都指这个目录。如果宿主把 `$SKILL_DIR` 设成了别的值，请改用**本 `SKILL.md` 实际所在目录**。

## 模型族与接口协议

这里有两个独立维度，别混：

- **模型族（family）**：`openai` / `gemini` / `grok`，决定模型 ID 和默认站点
- **接口协议（api）**：`openai`（默认，OpenAI 兼容 `/images/generations`）/ `official`（各家官方接口）

**默认全部走 OpenAI 兼容接口**，包括 Gemini 和 Grok 的模型。也就是说：

- `family=gemini` + `api=openai` → 把 `gemini-*` 模型发给 `/images/generations`
- `family=grok` + `api=openai` → 把 `grok-imagine-image-*` 发给 `/images/generations`

这样聚合网关和中转站可以直接用同一套请求形状。

只有用户明确要求「用官方接口」「用 Gemini 原生接口」「走 xAI 官方」时，才切到 `api=official`：

| family | `api=openai`（默认） | `api=official` |
|---|---|---|
| openai | `/images/generations`，`size` 用比例 | `/images/generations`，`size` 用 `1024x1024` 这类像素值 |
| gemini | `/images/generations` | `/interactions`，`x-goog-api-key` |
| grok | `/images/generations` | `/images/generations` + `aspect_ratio` |

## 模型选择

内置 3 个 OpenAI 模型：

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

### Gemini 与 Grok 模型

其他模型族的内置模型：

| 族 | 短名 | model ID |
|---|---|---|
| gemini | `banana-2.1` | `gemini-nano-banana-2.1` |
| gemini | `banana-2-lite` | `gemini-3.1-flash-lite-image` |
| gemini | `banana-2` | `gemini-3.1-flash-image` |
| gemini | `banana-pro` | `gemini-3-pro-image` |
| gemini | `banana` | `gemini-2.5-flash-image` |
| grok | `grok-imagine-2` | `grok-imagine-image-2.0` |

这些模型**默认也走 OpenAI 兼容接口**。用 `--family` 选族：

```bash
node "$SKILL_DIR/scripts/generate.js" --family gemini --model banana-2.1 --prompt "..."
node "$SKILL_DIR/scripts/generate.js" --family grok --model grok-imagine-2 --prompt "..."
```

模型名也支持 `族:短名` 写法，例如 `--model gemini:banana-2.1`。

**`--family` 是过滤条件，不是「临时改身份」**：它只会从已有 profile 里挑出声明为该族的候选。
所以上面两条命令要求**已经有一个 `--family gemini`（或 `grok`）的 profile**，否则会报
`没有匹配 family=gemini 的 profile`。这种情况要先建 profile：

```bash
node "$SKILL_DIR/scripts/setup.js" --profile "banana" --family gemini \
  --base-url "https://your-gateway.example/v1" --api-key "KEY" --activate
```

聚合网关场景下，同一个 `base_url` 建两个 profile（一个 openai 族、一个 gemini 族）即可，
两者都走兼容接口，只是声明的模型族不同。

### 拉取站点真实支持的模型

模型列表因站点而异，用该 profile 自己的 URL 和 Keychain 里的 Key 拉一次：

```bash
node "$SKILL_DIR/scripts/setup.js" --sync-models [--profile "main"]
```

结果会写进 `profile.synced_models` 并合并进模型目录，之后就能直接 `--model <拉到的ID>` 使用，
也会出现在 `--list-models` 里。拉取只保留该模型族的生图模型；若一个都没识别到，会报错并提示用
`--add-model` 手动指定。

`--sync-models` 也可以和初始化写在同一条命令里（会先建 profile 再拉取）：

```bash
node "$SKILL_DIR/scripts/setup.js" --profile "main" --base-url "..." --api-key "..." --sync-models
```

**注意模型族**：拉取只保留**该 profile 声明的族**的模型。openai 族的站点只会拉到
`gpt-image-*` 这类，拉不到 `gemini-*`。要用 Gemini / Grok 模型，得单独建一个对应
`--family` 的 profile。

### 用户要切换接口协议时

- 「用官方接口 / 原生接口」→ `--api official`（本次）或初始化时 `--api official`（持久）
- 「还是走 OpenAI 兼容」→ `--api openai`
- 不点名时**保持默认 `openai`**，不要主动改成官方接口

```bash
node "$SKILL_DIR/scripts/generate.js" --family gemini --api official --prompt "..."
```

官方接口只发该家支持的字段。不支持会直接报错，不会静默透传。

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
   - **默认路径**：以上任一条件不满足时，直接用文字询问那 3 个值
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
- **图片已生成但下载失败**：不重试提交（重发等于重复扣费），直接换下一个 profile

**只有加 `--no-fallback` 才会只跑单 profile。** 单给 `--profile` 不会禁用 fallback——
它只是把该 profile 排到最前，失败后仍会尝试其它 profile。所以用户说「只用某个 profile」
「别换站点」时，命令必须写成：

```bash
node "$SKILL_DIR/scripts/generate.js" --profile "backup" --no-fallback --prompt "..."
```

### 初始化方式一：文字询问（默认路径）

这是所有环境都必须可用的基线。第一条回复应尽量接近下面这个形式：

`当前会先初始化 oh-coage。我需要你提供 3 个值：1. profile 名称 2. 站点 URL 3. API Key。图片会自动存到项目目录或桌面，不需要你选文件夹。`

不要在这条回复里插入额外的工具探索、替代方案说明或别的链路检查。

### 初始化方式二：可视化表单（仅限支持的环境）

只有在当前环境确实支持 inline HTML 渲染且存在 `window.openai.sendFollowUpMessage` 时才走这条路径。不要把它当作默认路径：在普通 CLI / 终端类 agent 里它不可用，强行渲染只会浪费一轮。

1. 运行 `node "$SKILL_DIR/scripts/resolve-output-dir.js"` 得到默认保存目录
2. 使用 `assets/oh-coage-init-form.html`，按宿主的 inline HTML 流程渲染，并把 `outputDir` 预填为上一步的结果（该字段非必填，用户可清空）
3. 如果解析结果是项目根目录，把表单根节点的 `data-has-project` 设为 `true`；否则保持 `false`，并把保存目录预填为桌面
4. 第一条回复只引导用户填表并展示表单，不要先用文字逐项询问，也不要把任何字段预填成真实密钥

表单提交后会发来一条包含 `OH_COAGE_INIT_FORM_SUBMISSION` 标记的结构化消息。收到这条消息后：

1. 直接解析其中的 `outputDir`、`profile`、`baseUrl`、`apiKey`、`family`、`api`、`model`
2. 用 `$SKILL_DIR/scripts/setup.js` 完成本地初始化，加上 `--activate`，把 `family` 通过 `--family`、`api` 通过 `--api` 一起传入，并把 `model` 通过 `--model` 一起传入（`setup.js` 支持初始化和 `--model` 同时给，会先初始化再切换全局模型）。`outputDir` 为空时**不要传** `--output-dir`，让脚本自动推导
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

如果用户第一次使用，或者脚本提示“尚未完成 oh-coage 初始化”，先按上面的方式判定初始化路径，不要直接生成图片。无论走哪条路径，最终都需要这 3 个值：

1. profile 名称是什么
2. 站点 URL 是什么
3. API Key 是什么

**图片保存目录不是必填项。** 不要主动追问文件夹；用户没提就省略 `--output-dir`，脚本会自动落到项目根目录（有项目时）或桌面。只在用户明确说“存到某个目录”时才传。

然后运行：

```bash
node "$SKILL_DIR/scripts/setup.js" \
  --profile "default" \
  --base-url "https://your-image-site.example/v1" \
  --api-key "YOUR_KEY" \
  --activate
```

初始化行为：

- 在输出目录（用户指定或自动推导）中创建 `oh-coage-config.json`
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

### 参考图字段怎么发（适配不同站点）

各站点对参考图的字段名、传输方式、端点写法都不统一，所以这三件事做成可配置的。**不配就是内置默认，行为和以前完全一致。**

默认（`api=openai`）：JSON 请求体，参考图放在 `image_urls`，打 `POST /images/generations`。

| 配置项 | 取值 | 默认 |
|---|---|---|
| `image_transport` | `json` / `multipart` | `json` |
| `image_field` | 任意字段名，常用 `image_urls`、`image`、`images`、`image_url`、`input_image`、`init_image`、`reference_images` | `json` 时 `image_urls`；`multipart` 时 `image` |
| `image_shape` | `array`（`["data:..."]`）/ `array-object`（`[{"url":"..."}]`）/ `single`（单值字符串） | `image_urls` 系字段为 `array`；`images` / `input_images` / `reference_images` 自动为 `array-object` |
| `image_endpoint` | 相对路径或完整 URL | `json` 时 `/images/generations`；`multipart` 时 `/images/edits` |

`image_shape` 三个取值的实际效果：

| 取值 | 发出去的 JSON |
|---|---|
| `array` | `"image_urls": ["data:...", "data:..."]` |
| `array-object` | `"images": [{"url": "data:..."}, {"url": "data:..."}]` |
| `single` | `"image_url": "data:..."` |

**`single` 只能配一张参考图。** 传多张会直接报错并提示改用 `array` / `array-object`，
不会静默丢掉多余的图。

常见站点的对法：

| 站点认的写法 | 该配什么 |
|---|---|
| `image_urls` 字符串数组（默认） | 什么都不用配 |
| `image` / `image[]` 文件上传（OpenAI `/images/edits`、多数改图接口） | `--image-transport multipart` |
| `images: [{"url": ...}]` | `--image-field images` |
| `image_url` 单张字符串 | `--image-field image_url --image-shape single` |
| 改图走别的路径，比如 `/v1/image/edit` | 再加 `--image-endpoint /image/edit` |

`multipart` 会把参考图当成真正的文件字段上传（文件名 `reference-1.png` 等），**只支持本地文件或 data URI**。传远程 URL 会直接报错，提示先下载到本地或改用 `json`。

注意 `api=official` 的 OpenAI 官方接口本来就该走 `/images/edits` + multipart，现在给参考图时会自动这么发，不用额外配。

### 配置适配项

写到 profile 里，之后每次图生图都生效：

```bash
# 该站点要 multipart 文件上传
node "$SKILL_DIR/scripts/setup.js" --image-transport multipart

# 字段名和形状都要指定
node "$SKILL_DIR/scripts/setup.js" --image-field images

# 连端点一起指定
node "$SKILL_DIR/scripts/setup.js" --image-field image_url --image-shape single --image-endpoint /image/edit

# 清除，回到内置默认
node "$SKILL_DIR/scripts/setup.js" --clear-image-options
```

不写 `--profile` 就作用于当前 profile。初始化时也能一次带上这些参数。

单次覆盖用 `generate.js` 的同名参数，优先级是：`generate.js` 参数 > profile 配置 > 内置默认。

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "把这张图改成水彩风格" \
  --image-url "/path/to/photo.png" \
  --image-transport multipart
```

`setup.js --list` 会把非默认的适配项一并打出来，方便确认当前站点到底怎么发。

### 遇到 400 时怎么排查

生成时 stderr 会打印一行 `参考图片: N 张；适配: 端点=..., 传输=..., 字段=..., 形状=...`，先看这一行：

1. 端点对不对：站点改图接口不是 `/images/generations` 就配 `--image-endpoint`
2. 传输对不对：报 `multipart/form-data` 相关错误就切 `--image-transport multipart`，报 JSON 解析错误就切回 `json`
3. 字段名对不对：看站点文档里参考图叫什么，直接配 `--image-field`
4. 形状对不对：报类型错误（期望数组却给了对象，或反过来）就调 `--image-shape`

不确定站点认哪一种时，先保持默认试一次；默认那套对大多数中转站有效。

## 参数选择

### 默认（OpenAI 兼容接口）

- `--size` 默认 `1:1`，宽屏优先 `16:9`，竖屏/壁纸优先 `9:16`，海报优先 `2:3`
- `--resolution` 默认 `2k`；用户说高清或 4K 时优先 `4k`，说快速/省钱时优先 `1k`
- `--n` 可选，生成多张（各接口上限不同，Grok 官方接口为 1–10）
- `--quality` / `--style` / `--response-format` / `--user` 会原样透传，兼容不同中转站

默认模型是 `gpt-image-2`。用户没有提模型时，不要主动换成 2.5 系列——2.5 是不同档位，可能更贵。

### 全部可用参数

生成（`generate.js`）：

| 参数 | 说明 |
|---|---|
| `--prompt` | **必填**，提示词 |
| `--family` | `openai` / `gemini` / `grok` |
| `--api` | `openai`（默认）/ `official` |
| `--model` | 单次指定模型，不改持久配置 |
| `--profile` | 指定优先尝试的 profile（**不会**禁用 fallback） |
| `--size` | 比例，如 `1:1` / `16:9` |
| `--resolution` | `1k` / `2k` / `4k` |
| `--image-size` | `512` / `1K` / `2K` / `4K`（Gemini 官方） |
| `--n` | 生成张数 |
| `--quality` | 质量，官方接口限 `low`/`medium`/`high`/`auto` |
| `--style` | 风格（**仅兼容接口**，官方接口不支持） |
| `--background` / `--output-format` / `--output-compression` / `--moderation` | OpenAI 官方接口专属 |
| `--response-format` | `url` / `b64_json` |
| `--user` | 用户标识 |
| `--image-url` | 参考图，可重复；支持 URL / data URI / 本地路径 |
| `--image-field` / `--image-transport` / `--image-shape` / `--image-endpoint` | 图生图适配 |
| `--base-url` / `--api-key` | 单次覆盖站点与密钥 |
| `--out-dir` | 本次输出的总目录（每次生成仍会新建时间子目录） |
| `--output` | 本次输出到指定文件（多图自动加 `-2`/`-3`） |
| `--json` | stdout 输出结构化 JSON |
| `--no-fallback` | **只用第一个候选 profile**，失败不换 |

**`--profile` 和 `--no-fallback` 的区别**（容易混）：

- `--profile backup`：把 `backup` 排到最前，失败后**仍会**尝试其它 profile
- `--profile backup --no-fallback`：只用 `backup`，失败就报错

用户说「只用某个 profile」「别换站点」时，必须同时给 `--no-fallback`。

### 尺寸与分辨率校验

- 兼容接口只校验**格式**：`--size` 必须是比例（`1:1`、`16:9`），`--resolution` 必须是 `1k`/`2k`/`4k`
- 传像素值（`1024x1024`）会被拒绝并提示改用 `--api official`
- `--resolution 4k` 只在 `16:9`、`9:16`、`2:1`、`1:2`、`21:9`、`9:21` 下可用；
  其它比例会自动降级到 `2k` 并在 stderr 提示

### 官方接口专属参数

切到 `--api official` 后，字段会按家映射：

- **OpenAI 官方**：`--quality low|medium|high|auto`、`--background`、`--output-format png|jpeg|webp`、`--output-compression 0-100`、`--moderation`；`--size` 接受 `1:1` / `2:3` / `3:2` 并换成像素值
- **Gemini 官方**：`--size` 作 `aspect_ratio`，`--image-size 512|1K|2K|4K`；不支持 `quality` / `style` / `response_format`
- **Grok 官方**：`--size` 作 `aspect_ratio`，`--resolution 1k|2k`，`--quality low|medium|auto`，`--response-format url|b64_json`；不支持 `background` / `output_format` / `style`

传了该家不支持的字段会报错，这时要么去掉，要么换接口协议。

## 错误语义与重试

脚本会自动区分「该重试」和「不该重试」的错误，不要自己再包一层重试逻辑。

| 情况 | 行为 | 原因 |
|---|---|---|
| 401 / 403 | 不重试，换下一个 profile | 鉴权失败，重试无意义 |
| 408 / 429 / 5xx | 同 profile 退避重试 1 次，仍失败再换 profile | 服务端明确失败，没产出图片 |
| 连接被拒绝 / 域名解析失败 | 重试 | 请求根本没发出去 |
| **超时 / 连接被重置** | **不重试提交**，直接换 profile | 服务端可能已收到并计费，重发等于重复扣费 |
| **图片已生成但下载失败** | **不重试提交**，直接换 profile | 同上；错误信息会写「不会重试提交」 |
| Keychain 读不到 key | 跳过该 profile | 只影响这一个 profile |
| 非图片响应（错误页/限流 JSON） | 报错，不落盘 | 避免「显示成功但图片是坏的」 |

用户看到「不会重试提交」时，说明**图片已经生成成功、钱已经花了，只是没下载下来**。
这时不要建议用户重跑（会再扣一次费），而应该：

1. 检查网络能否访问图片 URL
2. 或用 `--profile` 换一个更稳定的站点

## 输出与展示

生图完成后，**直接在对话里把图片展示出来**，不要只回一句“已保存到 xxx”。

### 先拿到结构化结果

用 `--json` 跑生成，stdout 是一份可直接解析的 JSON：

```json
{
  "status": "success",
  "family": "gemini",
  "api": "openai",
  "model": "gemini-nano-banana-2.1",
  "run_dir": "/path/to/20261021-153012",
  "images": [
    { "source": "url", "url": "https://...", "path": "/path/to/a.png", "display": "https://..." }
  ]
}
```

### URL 和 base64 都要兼容

接口可能返回远程 URL，也可能返回 base64。脚本已经把两种都处理成可展示的形式，你只需要看 `display` 字段：

| `source` | 含义 | 怎么展示 |
|---|---|---|
| `url` | 接口直接给了图床地址 | 用 `display`（即远程 URL）直接渲染；`path` 是同时落盘的副本 |
| `base64` | 接口只给了图片数据 | base64 无法直接当图片地址用，必须用 `display`（即本地文件路径）渲染 |

两种情况下 `display` 都已经填好，**不要自己拼 data URI 或重新编码**。

### 展示方式

1. 宿主有图片/媒体渲染能力（`visualize`、图片组件、附件等）→ 用它渲染 `display`
2. 没有专用能力 → 用 Markdown 图片语法：`![生成的图片](display)`
3. 本地路径渲染不出来时，把绝对路径也一并告诉用户，让他自己打开

多张图时逐张展示，不要只给第一张。

### 文件落盘

- 默认会落盘：`<总目录>/<时间戳>/oh-coage-<序号>.png`
- 用户显式传 `--output` 时保存到指定文件（多图时自动追加 `-2`、`-3`）
- 落盘是默认策略：base64 不落盘就没法展示，URL 落盘则避免图床过期后找不到
