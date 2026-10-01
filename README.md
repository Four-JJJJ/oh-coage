# oh-coage

一个给 Codex / Claude Code / 其他 AI coding agent 使用的图片生成 skill。

这个 skill 默认使用 `gpt-image-2`，并内置另外两个模型可选，也支持你自己追加模型；但不绑定某一家站点。它支持你在**首次使用时本地初始化**：

- 让用户先决定图片总保存目录
- 让用户填写站点 `base_url`
- 让用户填写 `api_key`
- 把敏感的 `api_key` 存进 **macOS Keychain**
- 把非敏感配置写进用户指定目录下的本地配置文件
- 支持多个 profile 之间切换
- 支持文生图、图生图、同步返回接口、异步任务接口

## 功能概览

- 模型可选：3 个内置模型 + 自定义模型，可持久切换
- 首次使用初始化
- 默认本地保存图片
- 多 profile 管理
- 自动 fallback 到备用 profile
- 健康检查命令
- 运行日志记录
- Keychain 存储密钥
- 兼容：
  - 同步接口：请求后直接返回图片 URL 或 base64
  - 异步接口：提交任务后轮询结果

## 目录结构

```text
.
├── SKILL.md                  # 入口指针（仓库根作为 skill 目录时使用）
├── README.md
└── skills/oh-coage/          # skill 实体，自包含
    ├── SKILL.md              # 唯一权威文档
    ├── assets/
    │   └── oh-coage-init-form.html
    └── scripts/
        ├── config-store.js
        ├── generate.js
        ├── models.js
        ├── resolve-output-dir.js
        └── setup.js
```

`skills/oh-coage/` 是可以整体拷走或软链的完整 skill 目录，`SKILL.md`、`scripts/`、`assets/` 三者同级。下文命令中的 `$SKILL_DIR` 即指这个目录。

## 运行要求

### 1. Node.js

需要本机已安装 Node.js。

检查方式：

```bash
node -v
```

### 2. macOS Keychain

当前默认方案依赖 macOS 自带的 `security` 命令将 `api_key` 写入 Keychain。

也就是说，这个版本的“安全存储 key”方案是为 **macOS** 优先设计的。

## 缺少依赖时的处理原则

如果用户机器上缺少依赖，不应直接静默安装。正确做法是：

1. 先告诉用户缺少什么
2. 再说明为什么必须补这个依赖
3. 最后询问用户是否允许补齐

建议按下面的理由说明：

- 缺少 `Node.js`
  - 因为 `setup.js` 和 `generate.js` 都需要 Node.js 执行
- 缺少 `security`
  - 因为这个 skill 依赖 macOS Keychain 安全保存 API Key，而不是把 key 明文写进配置文件
- Keychain 不可用
  - 因为后续无法安全读取 key，也无法稳妥支持多 profile 切换

只有在用户明确同意后，再继续补依赖或引导安装。

## 安装方式

这个仓库同时支持传统 skill 和 Codex plugin 两种安装方式。插件结构位于：

```text
.
├── .codex-plugin/plugin.json
├── .agents/plugins/marketplace.json
├── skills/oh-coage/SKILL.md
├── skills/oh-coage/assets/
└── skills/oh-coage/scripts/
```

### Codex plugin

仓库公开后，任何人都可以从 GitHub 安装这个插件：

```bash
codex plugin marketplace add Four-JJJJ/oh-coage --ref main
codex plugin add oh-coage@oh-coage
```

`--ref main` 跟随最新提交。如果你想要可复现的稳定版本，改用已发布的 tag（版本号见 [Releases](https://github.com/Four-JJJJ/oh-coage/releases)）：

```bash
codex plugin marketplace add Four-JJJJ/oh-coage --ref v0.2.0
codex plugin add oh-coage@oh-coage
```

代价是不主动重装就收不到后续更新。

更新到最新版本时：

```bash
codex plugin marketplace upgrade oh-coage
codex plugin add oh-coage@oh-coage
```

安装只会获取插件代码。每位用户都需要在自己的机器上完成初始化并提供自己的站点地址和 API Key；密钥不会随仓库、插件包或配置文件分发。

### 传统 skill

先把仓库克隆到本地固定位置：

```bash
git clone https://github.com/Four-JJJJ/oh-coage.git
```

**推荐做法**：把 `skills/oh-coage` 这个自包含目录软链到你的 agent skills 目录。这样 `$SKILL_DIR` 就指向 skill 实体，文档里的 `$SKILL_DIR/scripts/...` 天然正确。

```bash
ln -s "/path/to/oh-coage/skills/oh-coage" ~/.claude/skills/oh-coage
```

**另一种做法**：把仓库根目录本身当作 skill 目录。此时根目录的 `SKILL.md` 只是入口指针，会把你导向 `skills/oh-coage/SKILL.md`；按该文件的说明，你需要把 `skills/oh-coage/` 视为 `$SKILL_DIR`。

## Skill 触发场景

当用户说出这类需求时，应触发这个 skill：

- 生图
- 画图
- 生成图片
- 帮我画
- 用 gpt 画
- 把这张图改成……
- 参考这张图……
- image generate
- image edit
- oh-coage
- gpt-image

## 首次使用流程

第一次使用时，不要直接调用生成脚本，先初始化。

在支持 inline HTML 渲染的 Codex 类环境里，初始化会优先展示一个可交互表单，填写 profile、站点 URL、API Key 和默认模型后提交。图片保存目录会自动使用当前项目根目录；没有项目上下文时默认使用桌面，也可以手动修改路径。

其他环境（普通 CLI agent、终端类宿主）不具备表单能力，会直接回退到聊天输入这一基线路径。判定方式是**先看能力再选路径**，不是先试表单再回退。

无论走哪条路径，最终都需要这 4 个值：

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

首次初始化时，macOS 可能会弹出 Keychain 授权窗口。

- 这是正常行为，因为 skill 需要把真实 `API Key` 写入系统 Keychain
- 用户需要在弹窗里点“允许”
- 如果点了“拒绝”或直接关闭弹窗，这次初始化会失败；重新执行一次 `setup.js` 即可

### 初始化完成后会发生什么

会写入 3 类数据：

1. 用户指定目录中的配置文件

示例：

```text
<图片总目录>/oh-coage-config.json
```

2. 全局状态文件

```text
~/.oh-coage/state.json
```

这个文件只记录“当前配置文件路径”。

3. macOS Keychain 中的密钥

- service: `oh-coage`
- account: `profile名 + 配置文件路径哈希`

### 配置文件里保存什么

配置文件只保存非敏感字段，例如：

```json
{
  "version": 1,
  "active_profile": "main",
  "profiles": {
    "main": {
      "base_url": "https://image.example.com/v1",
      "root_output_dir": "<图片总目录>"
    }
  }
}
```

不会把真实 `api_key` 写进这个文件。脚本会额外维护一个由系统使用的 Keychain account 标识，但它不需要手动填写或共享。

字段语义上，`root_output_dir` 表示图片总目录。每次生成时，脚本会在这个总目录下再自动创建一个时间命名的任务子目录。

## 日常生成图片

初始化完成后，正常文生图：

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "a simple red apple on white background" \
  --size "1:1" \
  --resolution "1k"
```

默认行为：

- 读取当前 active profile
- 使用配置文件里的当前模型（`--model` 可单次覆盖）
- 自动从 Keychain 读取该 profile 的 key
- 优先调用当前 active profile，对可重试错误会自动 fallback 到下一个可用 profile
- 生成成功后先在该 profile 的总目录下创建一个时间命名子文件夹，再把图片保存进去
- `stdout` 输出最终本地文件路径
- 同时会在 `~/.oh-coage/runs.jsonl` 追加一条运行日志
- 每次任务目录内还会写一个 `meta.json`

## 图生图

当用户提供参考图时，加上 `--image-url`：

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "turn this into watercolor style" \
  --image-url "https://example.com/photo.jpg"
```

支持：

- 单张参考图
- 多张参考图（重复传 `--image-url`）
- URL
- base64 data URI
- 本地图片文件路径（脚本会自动转为 base64 data URI 上传给接口）

本地图片路径示例：

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "turn this into watercolor style" \
  --image-url "/path/to/input.png"
```

支持的本地图片格式：`png`、`jpg`、`jpeg`、`webp`、`gif`。

## 参数说明

### `generate.js`

```bash
node "$SKILL_DIR/scripts/generate.js" [options]
```

主要参数：

- `--prompt`
  - 必填，图片提示词
- `--model`
  - 可选，本次使用的模型，接受短名或原始 model ID
  - 不传则用配置文件里的当前模型，再退回默认 `image-2`
- `--profile`
  - 可选，临时指定本次生成使用哪个 profile
- `--size`
  - 可选，默认 `1:1`
- `--resolution`
  - 可选，默认 `2k`
- `--image-url`
  - 可选，图生图参考图
- `--base-url`
  - 可选，临时覆盖 profile 中的 `base_url`
- `--api-key`
  - 可选，临时覆盖 Keychain 中读取到的 key
- `--output`
  - 可选，保存到指定文件路径
- `--out-dir`
  - 可选，保存到指定目录

### `setup.js`

```bash
node "$SKILL_DIR/scripts/setup.js" [options]
```

主要参数：

- `--output-dir`
  - 初始化或新增 profile 时，指定图片总保存目录
- `--profile`
  - 初始化或新增 profile 时，指定 profile 名
- `--base-url`
  - 初始化或新增 profile 时，指定图片站点地址
- `--api-key`
  - 初始化或新增 profile 时，写入 Keychain 的密钥
- `--activate`
  - 初始化后立即设为当前默认 profile
- `--list`
  - 列出所有 profile
- `--activate-profile`
  - 切换当前默认 profile
- `--health-check`
  - 检查所有 profile 的本地配置健康度
- `--live`
  - 与 `--health-check` 配合使用，增加一次低成本可达性探测
- `--list-models`
  - 列出所有可用模型，并标出当前模型
- `--model`
  - 切换当前模型，写入配置文件并持续生效
- `--add-model`
  - 添加或更新一个自定义模型的短名
- `--model-id`
  - 配合 `--add-model`，指定该短名对应的真实 model ID
- `--label`
  - 可选，配合 `--add-model` 给自定义模型加一句说明
- `--delete-model`
  - 删除一个自定义模型（内置模型不可删）
- `--profile-model`
  - 给某个 profile 固定模型；不写 `--profile` 则作用于当前 active profile
  - 传 `none` 取消固定，改为跟随全局当前模型

## 多 profile 管理

### 查看已有 profile

```bash
node "$SKILL_DIR/scripts/setup.js" --list
```

### 健康检查

本地无成本检查：

```bash
node "$SKILL_DIR/scripts/setup.js" --health-check
```

带在线探测的检查：

```bash
node "$SKILL_DIR/scripts/setup.js" --health-check --live
```

默认检查内容：

- profile 是否启用
- `base_url` 格式是否合法
- 输出总目录是否可写
- Keychain 中是否能读到对应 key

加上 `--live` 后，还会额外探测该 `base_url` 是否可达。

### 新增一个 profile

```bash
node "$SKILL_DIR/scripts/setup.js" \
  --output-dir "/path/to/backup-images" \
  --profile "backup" \
  --base-url "https://another-image-site.example/v1" \
  --api-key "YOUR_BACKUP_KEY"
```

### 切换默认 profile

```bash
node "$SKILL_DIR/scripts/setup.js" --activate-profile "backup"
```

### 临时用某个 profile 生成一次

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --profile "backup" \
  --prompt "a minimal poster"
```

### 删除某个 profile

```bash
node "$SKILL_DIR/scripts/setup.js" --delete-profile "backup"
```

说明：

- 会同时删除这个 profile 对应的 Keychain 记录
- 如果它是当前 active profile，会自动切到剩余的第一个 profile
- 如果当前只剩最后一个 profile，脚本会阻止删除，并提示改用 `--uninstall-skill`

### 重命名某个 profile

```bash
node "$SKILL_DIR/scripts/setup.js" --rename-profile "old-name" --to "new-name"
```

说明：

- 会同步迁移 Keychain 中的 key 到新的 account 名
- 如果原来是 active profile，重命名后仍然保持 active

### 删除这个 skill 的本地配置

```bash
node "$SKILL_DIR/scripts/setup.js" --uninstall-skill
```

默认行为：

- 删除 `~/.oh-coage/state.json`
- 删除当前配置文件
- 删除所有 profile 对应的 Keychain 记录
- **保留** `~/.oh-coage/runs.jsonl`（里面有历史 prompt，可能还要追溯）
- 不删除 skill 仓库目录本身

如果你只想部分清理：

```bash
node "$SKILL_DIR/scripts/setup.js" --uninstall-skill --keep-config-file
```

```bash
node "$SKILL_DIR/scripts/setup.js" --uninstall-skill --keep-keychain
```

如果你连运行日志也要一起清掉：

```bash
node "$SKILL_DIR/scripts/setup.js" --uninstall-skill --purge-logs
```

## 模型选择

内置 3 个模型：

| 短名 | 实际发给接口的 model ID | 说明 |
|---|---|---|
| `image-2` | `gpt-image-2` | 默认模型 |
| `image-2.5-sunburst` | `gpt-image-2.5-sunburst` | 2.5 系列 |
| `image-2.5-flare` | `gpt-image-2.5-flare` | 2.5 系列 |

### 查看可选模型

```bash
node "$SKILL_DIR/scripts/setup.js" --list-models
```

### 切换模型（持久生效）

```bash
node "$SKILL_DIR/scripts/setup.js" --model "image-2.5-flare"
```

切换后会写进配置文件，**后续每次生成都用这个模型，直到你再次切换**。

### 单次临时指定

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --model "image-2.5-sunburst" \
  --prompt "a minimal poster"
```

`--model` 只影响这一次，不改动持久配置，优先级高于配置里的当前模型。

也可以直接传原始 model ID：

```bash
node "$SKILL_DIR/scripts/generate.js" --model "gpt-image-2.5-flare" --prompt "..."
```

### `2.5` 为什么不直接选

`2.5`、`image-2.5`、`gpt-image-2.5` 都属于**歧义输入**。脚本会拒绝执行并列出两个候选，而不是替你猜——这两个模型的档位不同，猜错会白花一次配额。请显式写 `image-2.5-sunburst` 或 `image-2.5-flare`。

### 添加自定义模型

如果你的站点还有别的模型，先向服务方确认它要求的准确 model ID 字符串，然后：

```bash
node "$SKILL_DIR/scripts/setup.js" \
  --add-model "my-model" \
  --model-id "vendor-model-id" \
  --label "我的模型"
```

之后就能像内置模型一样使用：

```bash
node "$SKILL_DIR/scripts/setup.js" --model "my-model"
```

删除：

```bash
node "$SKILL_DIR/scripts/setup.js" --delete-model "my-model"
```

约束：

- 内置模型不允许删除
- 自定义短名不能与内置短名重名
- 删掉的正是当前模型时，会自动回到 `image-2`
- 添加时不给 `--model-id` 会被拦下，并提示你向用户确认 model ID

### 给某个站点固定模型

不同站点支持的模型可能不同。可以把某个 profile 固定到它支持的模型：

```bash
# 固定 main 这个 profile
node "$SKILL_DIR/scripts/setup.js" --profile-model "image-2.5-flare" --profile "main"

# 不写 --profile 则作用于当前 active profile
node "$SKILL_DIR/scripts/setup.js" --profile-model "image-2.5-flare"

# 取消固定，让它跟随全局当前模型
node "$SKILL_DIR/scripts/setup.js" --profile-model none --profile "main"
```

初始化时也可以顺手固定：

```bash
node "$SKILL_DIR/scripts/setup.js" \
  --output-dir "/path/to/images" \
  --profile "main" \
  --base-url "https://example.com/v1" \
  --api-key "KEY" \
  --profile-model "image-2.5-sunburst"
```

### 模型优先级

一个候选 profile 实际用哪个模型，按这个顺序决定：

1. `generate.js --model`（本次显式指定，压过一切）
2. 该 profile 的 `model` 字段（`--profile-model` 固定）
3. 配置里的 `current_model`（`setup.js --model` 切换的全局值）
4. 默认 `image-2`

所以在 fallback 链上，**每个 profile 会各自用自己固定的模型**；没固定的才跟随全局。用 `--list-models` 看全局值，用 `--list` 看每个 profile 是否固定了模型。

如果某个 profile 固定了一个已经不存在的模型（比如自定义模型被删了），生成时该 profile 会被跳过并打印提示，而不是中断整轮。

## 比例和分辨率建议

### 比例建议

- 默认：`1:1`
- 宽屏：`16:9`
- 竖屏 / 手机壁纸：`9:16`
- 海报：`2:3`

支持的比例：

`auto`、`1:1`、`3:2`、`2:3`、`4:3`、`3:4`、`5:4`、`4:5`、`16:9`、`9:16`、`2:1`、`1:2`、`21:9`、`9:21`

### 分辨率建议

- 默认：`2k`
- 快速 / 省钱：`1k`
- 高清：`4k`

### 4K 限制

4K 仅支持：

- `16:9`
- `9:16`
- `2:1`
- `1:2`
- `21:9`
- `9:21`

如果用户传了不支持的比例，脚本会自动降级到 `2k`。

## 输出行为

默认输出是**本地文件路径**，不是只给 URL。

这是为了让用户直接拿到产物，减少再次下载的步骤。

如果接口返回的是：

- 图片 URL：脚本会自动下载再保存
  - 会跟随 301/302/303/307/308 跳转（最多 5 跳），适配「生成接口给短链、真实图在 CDN」的常见结构
  - 扩展名按响应 `content-type` 校正，不靠 URL 猜
  - 下载中断时会删掉残缺文件，不会给你留下一张看起来正常、实际打不开的空图
- base64：脚本会直接解码为本地图片文件

## 临时覆盖机制

虽然日常推荐走 profile，但也支持临时覆盖：

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "a blue mug" \
  --base-url "https://temp-site.example/v1" \
  --api-key "TEMP_KEY" \
  --out-dir "/tmp/images"
```

适合：

- 临时测试新站点
- 临时切换 key
- 不想改当前默认 profile

### 环境变量

除命令行参数外，也认这两个环境变量（优先级低于显式参数）：

- `IMAGES2_GEN_API_KEY`
- `IMAGES2_GEN_BASE_URL`

适合在 CI 或临时脚本里注入，不必把 key 写进命令行。注意：这只覆盖单次运行，不会写入配置文件。

### profile 优先级

每个 profile 可以带一个可选的 `priority` 数字字段，写在配置文件里：

```json
{
  "profiles": {
    "main": { "base_url": "https://a.example/v1", "root_output_dir": ".", "priority": 10 },
    "backup": { "base_url": "https://b.example/v1", "root_output_dir": ".", "priority": 20 }
  }
}
```

数字小的先尝试。不写时默认为 `100`。当前 active profile 和被 `--profile` 指定的 profile 永远优先于 `priority`。

## 异步任务回收

如果生成接口返回 `task_id`，脚本会按递增节奏回收任务结果：

```text
5s -> 10s -> 20s -> 30s -> 60s -> 60s -> 60s
```

如果最后一档后任务仍未完成，会继续以 `60s` 间隔查询，直到达到 5 分钟总超时。每轮都会在 `stderr` 输出当前进度、回收次数和下一轮等待时间。

## 自动 fallback

生成图片时，脚本会按 profile 顺序尝试。

当前顺序规则：

- 先用当前 active profile
- 如果指定了 `--profile`，优先从该 profile 开始
- 其他 profile 作为后续候选

遇到下面这类错误，会**先在当前 profile 上退避重试一次**，仍然失败才切到下一个候选 profile：

- `500`
- `502`
- `503`
- `504`
- `408`
- `429`
- 网络超时
- 连接重置或连接失败

其中：

- `429` 退避 `1.5s × 重试次数`，其余可重试错误退避 `1s × 重试次数`
- `401` / `403` 不重试，直接判定该 profile 当前不可用并切换
- Keychain 里读不到某个 profile 的 key 时，只跳过该 profile，不会中断整轮
- `base_url` 协议不是 `http`/`https` 的 profile，会在开始尝试前就被跳过并提示
- 异步任务轮询期间遇到可重试错误，也会在同一个任务上重试，最多连续失败 3 次

如果你想禁用自动 fallback：

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "a blue mug" \
  --no-fallback
```

## 运行日志

每次生成都会写入：

```text
~/.oh-coage/runs.jsonl
```

每条日志会记录：

- 开始时间
- prompt 摘要
- 使用的 profile
- 使用的模型（`model` / `model_key` / `model_source`，以及显式指定的 `requested_model`）
  - `model_source` 取值：`cli`（`--model` 指定）/ `profile`（profile 固定）/ `config`（全局当前）/ `default`
- 每次尝试的错误码 / 错误类型
- 最终是否成功
- 保存路径
- 总耗时

错误正文会被截断到 500 字符再落盘，避免上游返回的大段 HTML 或 base64 把日志撑爆。

## 安全说明

这个版本的设计目标是：

- **不把 key 写进仓库**
- **不把 key 写进 README**
- **不把 key 写进 skill 文档**
- **不把 key 写进普通本地配置文件**
- **不把 key 写进截图、日志、Obsidian**

默认只允许：

- 配置文件保存非敏感字段
- Keychain 保存真实 key

## 常见问题

### 1. 提示“尚未完成 oh-coage 初始化”

说明还没有初始化，先运行：

```bash
node "$SKILL_DIR/scripts/setup.js" \
  --output-dir "/absolute/path/to/save" \
  --profile "default" \
  --base-url "https://your-image-site.example/v1" \
  --api-key "YOUR_KEY" \
  --activate
```

### 2. 提示无法从 Keychain 读取 key

通常是：

- profile 里记录的 `keychain_account` 不存在
- 当前机器的 Keychain 中没有那条记录
- 手动删过 Keychain 项

最直接的修复方式是重新运行一次对应 profile 的 `setup.js`。

### 3. 提示 Keychain 授权被取消或被拒绝

通常是首次初始化时：

- 系统弹出了 Keychain 授权窗口
- 用户点了“拒绝”
- 或者直接把弹窗关掉了

处理方式：

- 重新执行一次 `setup.js`
- 在 macOS 的 Keychain 授权弹窗里点“允许”
- 如果还是失败，先确认当前登录了桌面会话，并且 `login.keychain-db` 处于可用状态

### 4. 图片没有保存到预期目录

检查：

- 当前 active profile 是哪个
- 这次是否传了 `--profile`
- 这次是否传了 `--output` 或 `--out-dir`

### 5. 接口不是异步任务结构，能不能用

可以。当前脚本兼容：

- 提交任务后返回 `task_id`
- 直接返回图片 URL
- 直接返回 base64

### 6. 能不能支持多个站点和多个 key

可以，这就是 profile 机制存在的原因。

## 建议工作流

推荐日常这样用：

1. 首次使用先初始化一个 `main` profile
2. 如果有第二个站点，再初始化一个 `backup` profile
3. 日常默认使用 `main`
4. 需要切换站点时：
   - 临时切换：生成时传 `--profile`
   - 长期切换：`setup.js --activate-profile`

## 开发与测试

需要 Node.js `>= 18`。

```bash
npm run check   # 四个脚本的语法检查
npm test        # 全部测试（node --test）
```

测试不依赖真实站点，也不写真实 Keychain：全部用本地 mock HTTP 服务 + 临时 `HOME` 目录跑。

覆盖范围包括：

- 配置文件读写、相对路径解析、派生字段不落盘
- 模型注册表解析、歧义拒绝、自定义模型增删、当前模型持久切换
- profile 固定模型、fallback 链上各 profile 各用各的模型
- 初始化与 `--model` 组合（先初始化再切换）、`security` 以 stub 替代以避开真实钥匙串
- 图生图本地上传、缺失参考图报错
- 下载跟随跳转、扩展名按 `content-type` 纠正、失败清理残文件
- 异步任务轮询节奏、瞬时故障重试、终态识别、结构非法快速失败
- 5xx 同 profile 重试、Keychain 读取失败 fallback、非法 `base_url` 拒绝
- 初始化表单结构、skill 目录自包含性、文档引用可达性

## Acknowledgements

致谢原始项目：

- [bozhouDev/images2-gen](https://github.com/bozhouDev/images2-gen)

## License

本项目采用 MIT License，详见 [LICENSE](./LICENSE)。
