---
name: oh-coage
description: 使用可配置站点生成图片，默认发送 OpenAI Images 生图请求，也支持用户明确指定 Gemini / Grok 等厂家原生协议。支持文生图、图生图、模型切换、按 URL + Key 拉取可用模型、多 profile 保存与 fallback。当用户说"生图"、"画图"、"生成图片"、"oh-coage"、"gpt-image"、"Image2 生图"、"帮我画"、"用 gpt 画"、"用 2.5 画"、"用 banana 画"、"用 grok 画"、"切换模型"、"换模型"、"换个模型"、"改成 xxx 模型"、"使用 xxx 模型"、"有哪些模型"、"拉取模型"、"用官方接口"、"把这张图改成"、"参考这张图"等涉及 AI 图片生成、图片编辑、模型或接口切换的请求时触发此技能。生成结果应直接在对话中展示图片，兼容接口返回 URL 与 base64 两种情况。首次使用时先做本地初始化：收集 profile 名、站点 URL 和 API Key（图片目录非必填，自动落到项目目录或桌面）；默认固定两步可视化表单，文字会话兜底；验证站点后全量拉取模型，按厂家设置主模型与可选的一个备选，同一 profile 保存各厂家配置和默认厂家；Key 写入本机 Keychain，本地配置文件只保存非敏感信息。
metadata:
  version: "0.11.0"
---

# 图片创作与模型管理

在本机配置服务后生成、编辑图片。默认对配置站点发送 OpenAI Images 生图请求；用户明确要求时，才切换到对应厂家的原生协议。**请求协议与模型厂家是两个独立设置**：使用 Gemini/Grok 厂家模型，不等于要走 Gemini/Grok 原生接口。初始化读取站点完整模型列表，不限制模型厂家。所有命令中的 `$SKILL_DIR` 指本文件所在目录。

## 执行入口

1. 先读当前配置：`node "$SKILL_DIR/scripts/setup.js" --list`。缺少配置、没有 active profile 或配置已删除时，进入初始化；配置损坏先报告路径并提供恢复/新建入口，不覆盖损坏文件。
2. 初始化、增加站点、编辑连接：读取 [references/onboarding.md](references/onboarding.md)。可视化表单为默认路径，宿主不支持时使用固定文字兜底。
3. 换模型、设置备选、换站点：读取 [references/interaction.md](references/interaction.md)。初始化和切换共用完整的厂家主备配置表单，站点选择单独处理。
4. 生图/改图：沿用当前 profile、默认厂家、该厂家的主备设置和参数；生成调用可能计费，遵守宿主的费用授权规则。初始化只读取模型列表，不能偷跑生图验证。
5. 成功逐张展示；失败读取 [references/errors.md](references/errors.md)，使用固定文案和与现有结果对应的恢复动作。默认只呈现简短原因与下一步，技术详情按需展开。未成功保存不能说“设置完成”；结果未知不能说“未计费”。

已完成配置时，图片生成/编辑请求优先使用本技能；用户明确要求其他路径时按其要求处理。

## 固定初始化

首次执行前读取 [references/onboarding.md](references/onboarding.md)，使用现成模板和脚本，不临时重写文案或表单。

- 第一步收集配置名称、服务地址、API Key。高级选项默认折叠；没有模型族字段。
- 连接列表接口通过后进入第二步：展示全量实际模型，按 OpenAI、Gemini、Grok 和其他模型分组。每家只展示两个下拉框：主模型、备选模型（可选），不使用复选框或排序。默认厂家仅在配置多家时显示。
- 只展示有模型且协议兼容的厂家；不额外展示搜索、编号、清空、重排等操作。主模型选“暂不设置”会清空该组备选；备选选“不使用备选”即可移除。
- 每页都有取消/返回入口；返回清理本次草稿，保留非敏感输入，不回填 Key。
- 宿主同时支持 inline HTML 和 `window.openai.sendFollowUpMessage` 才使用可提交表单；提交失败允许重试，缺少能力使用文字兜底。
- `OH_COAGE_CONNECTION_SUBMISSION` 与 `OH_COAGE_MODELS_SUBMISSION` 是现行桥接标记。旧 `OH_COAGE_INIT_FORM_SUBMISSION` 不再作为首次初始化入口；收到时映射到第一步，不直接保存。

### 初始化后的模型选择（必做）

模型选择就是第二步；通过 `onboarding.js --complete` 保存 `modelFamilies` 与 `activeFamily`。任意一家选好主模型即可完成，备选不必填写，其他厂家可以稍后再配。所有厂家的主备属于同一个 profile，无需为不同厂家另建站点。

配置存为 `profile.model_families[family] = {primary, fallbacks}` 和 `profile.active_model_family`，其中 fallbacks 只能为空数组或包含一个 ID。`profile.model` / `profile.fallback_models` 仅镜像默认厂家以兼容旧客户端；底层旧 `--primary-model` / `--fallback-model` 同步对应厂家设置，最多接受一个备选。

## 日常操作

### 用户想换模型时

打开 `manage.js --render` 的完整厂家主备配置表单，回填当前全部设置，用户可通过两个下拉框调整主模型和一个可选备选；配置多家时选择默认厂家。不要只给一个单选弹窗，也不要将本次意图自动保存为默认。

自然语言要求“切换模型 / 改成 X / 换个模型”时，若没说明主备，先问：“你想把它设为主模型，还是加入备选？”厂家无法唯一确定时一并确认；已经说清的内容不重复询问。用户明确说“把 Gemini 的主模型改成 X”可直接定位该组主模型，不要自己猜其他槽位。备选只有一个槽位，替换前展示新旧模型供确认；默认保留其他厂家与未涉及的备选。切换主模型不自动把旧主模型塞入备选；若新主来自备选，清空对应备选。完整表单供用户确认，并明确仅本次还是保存。

“这张用 X 画”是明确的单次生成指令，按当前站点准确 ID 或唯一简称解析，使用 `generate.js --model X`，不改变主备。多候选时列真实 ID 让用户选；不把跨站点合并目录当当前列表。

```bash
node "$SKILL_DIR/scripts/manage.js" --snapshot
node "$SKILL_DIR/scripts/manage.js" --render
```

使用 snapshot 返回的 revision，通过 stdin 将 `{profile,revision,modelFamilies,activeFamily,action:"temporary"|"default"}` 交给 `manage.js --apply`。保存修改当前 profile；仅本次不落盘，返回选中厂家的主模型供 `generate.js --profile ... --model ...`，本次只用该模型、不自动尝试临时备选，表单和确认消息如实说明。若要本次使用已保存厂家的完整主备链，用 `generate.js --family ...`，不改默认厂家。

旧 `setup.js --list-models` 是跨站点合并目录，仅供诊断。旧 `setup.js --model` 改全局兜底，不能用于日常切换；旧 `--profile-model` / `--primary-model` / `--fallback-model` 仅作兼容维护入口。

### 主备模型（同一个 profile 内）

不指定厂家时使用 active_model_family；点名 Gemini/Grok/OpenAI 时，使用该组的主模型与可选的一个备选。`--family` 选择厂家，不筛掉同一个兼容站点。备选只在同厂家内尝试，不自动跨厂家；仅配主模型即可生成。

“配置/管理模型”进入完整表单。需要重新验证列表时：`onboarding.js --edit-models` stdin `{profile}`，再 `--render-models <draftId>`，保存仍用 `--complete`；不新建 profile。列表刷新失败保留全部旧设置，提供重试、编辑连接或准确手动 ID 出口。

已保存但从列表消失的 ID 显示待处理，保留旧配置，保存前替换/移除；默认厂家被清空时必须另选有主模型的厂家。未知模型进入“其他模型”，不静默丢弃或猜厂家；官方协议不能使用未识别或不兼容的模型，改兼容连接或配置正确的原生连接。

旧配置在内存中按厂家拆分：每个厂家原顺序的第一项为主、下一项为备；多余旧备选不再执行，原文件读取时保留不变，原主模型所属厂家为默认。不读配置就写迁移；用户保存后才落盘新版字段。没有该厂家主模型时打开对应配置入口，不静默借用另一厂家。`--clear-fallback-models` 只清目标厂家的备选。实际生成用了备选时报告完整 ID，不改变持久主模型。

## 生成与恢复

```bash
node "$SKILL_DIR/scripts/generate.js" --prompt "用户的提示词" --json
node "$SKILL_DIR/scripts/generate.js" --profile "日常创作" --model "站点实际模型ID" --prompt "用户的提示词" --json
node "$SKILL_DIR/scripts/generate.js" --resume "/absolute/path/recovery-xxx.json" --json
```

默认仅使用当前站点、选定厂家的主备链，跨 profile 备选关闭。`--profile` 本次选站点，不改变 active；`setup.js --activate-profile NAME` 才改变默认站点。用户明确授权才传 `--allow-profile-fallback`；指定“只用某站点”加 `--no-profile-fallback`，仍可保留同站点模型链。

`--no-model-fallback` 关闭模型备选；`--no-fallback` 同时关闭两种备选。单次任务所有生成提交合计受 `--max-submissions` 限制，默认 3；达到上限停止并给出实际尝试，不自动增大预算。

| 失败 | 处理与出口 |
|---|---|
| 401 / Key 不可读 | 同一 Key 的模型无助于修复；提示编辑连接或解锁钥匙串，用户允许跨站点时才使用其他 profile |
| 明确模型不存在、模型权限拒绝 | 仅尝试当前厂家的一个备选，仍失败就停止；成功后展示实际模型 |
| 402 / 余额或额度不足（含 429 insufficient_quota） | 停止重试与自动备选，提示核对服务账户状态 |
| 真正的 429 限流 | 尊重 Retry-After，等待有上限；不能等待时停止并提供稍后再试入口 |
| 400/422 参数错误、普通 403、内容拒绝 | 停止并修正相应参数/权限/提示词，不自动换模型绕过 |
| 408/5xx、超时、连接重置、未知结果 | 停止全部生成提交，不换模型，也不换站点；保留恢复记录，查询原任务或让用户核对服务端记录 |
| 已有任务 ID / 图片但查询或下载失败 | 只用 `--resume` 恢复原任务；保留已保存图片，不重新生成 |
| 无法写入输出目录 | 生图前检查；让用户选可写目录再继续。已生成时使用恢复下载入口 |

安全重试由脚本统一管理，Agent 不自行循环重跑。`--resume` 从记录恢复任务 ID/图片，支持 `--out-dir` 或 `--output` 改下载位置，不发生成 POST；缺少任务 ID 且结果未知时提示核对服务端，不臆测失败。任务在服务端无法取消时，只停止本地等待，告知可能仍运行/计费；不能声称远端已取消。

恢复记录在提交前写入任务目录，拿到结果后才补充任务 ID、图片引用与部分完成状态，不含 API Key。有记录文件不代表能恢复：没有任务 ID 且没有图片时只提示核对服务记录，不提供无法执行的 resume 入口。任务已明确失败或完成却无图片时核对服务结果，不循环查询。未知结果、恢复 URL 过期、原配置删除时提供服务商任务页/恢复原连接/用户明确决定重新生成的出口。禁止把重新生成当成下载恢复。

## 协议与模型

兼容接口允许同一 profile 内跨模型族使用真实 ID，不按前缀过滤模型列表。9 个内置模型只是旧配置/简称支持，不可代替当前站点真实列表。默认 `api=openai` 使用 `/images/generations`。

默认用 `--api openai`（OpenAI Images 请求格式）发往已配置站点，模型可来自任意厂家；不要因为选了 Gemini/Grok 模型就自动切换协议。只有用户明确要求“使用厂家原生接口 / 官方接口”时才用 `--api official`，并确认原生接口厂家与连接凭据：OpenAI `/images/generations`，Gemini `/interactions`，Grok `/images/generations`（使用 aspect_ratio）。原生协议按 profile 保存的厂家身份路由，单个原生协议连接不能承载其他厂家模型；若要同站混用多厂家模型，应使用默认的 OpenAI Images 请求格式或为各原生厂家分别建立连接。协议不兼容必须提交前说明并给出切回 OpenAI Images 格式或建立对应原生连接的出口，不能向错误端点盲发。`--family` 仅选择本次使用的模型厂家，不会自动改变请求协议；原生 profile 的厂家身份也不能因选模型而改变，否则可能把 Key 发往错误接口。

准确 ID 优先；不完整简称基于当前站点目录解析，歧义时列真实候选。手动 ID 仅限用户或服务商明确提供，不编造。模型出现在列表中只证明列表可见，不证明支持出图或编辑；发现实际能力错误后提供修改主备/修正模型入口。

## 配置维护与隐私

配置管理、刷新、删除等具体路径见 [references/interaction.md](references/interaction.md)。密钥仅写本机 Keychain，配置不含 Key；JSON 用 stdin 传脚本，避免命令参数和临时明文文件。可视化桥接消息会进入会话，文案需如实说明。

所有配置写入带版本检查与互斥锁；过期表单拒绝覆盖，重新打开即恢复当前数据。完成提交幂等；同一草稿重复提交返回原结果，不重复创建。每个草稿只清理自身凭据，取消不删除既有配置。

依赖 Node.js >=20、macOS security/Keychain；缺失时说明原因并提供安装/稍后处理入口，不自动安装。钥匙串授权被拒绝时停止读取并提供解锁后重试，不反复弹授权。

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

### 全部可用参数

生成（`generate.js`）：

| 参数 | 说明 |
|---|---|
| `--prompt` | **必填**，提示词 |
| `--family` | 本次使用已配置的 `openai` / `gemini` / `grok` / `other` 厂家主备；不改默认 |
| `--api` | `openai`（默认）/ `official` |
| `--model` | 单次指定模型，不改持久配置 |
| `--profile` | 本次指定 profile，默认仅使用此站点 |
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
| `--no-fallback` | 关闭模型与跨站点备选 |

| `--no-model-fallback` | 关闭同站点的备选模型 |
| `--no-profile-fallback` | 关闭跨站点备选（默认已关闭） |
| `--allow-profile-fallback` | 用户明确同意后开启跨站点备选 |
| `--max-submissions` | 单次任务生成 POST 总上限，默认 3，包含重试与备选 |
| `--resume` | 恢复记录路径；仅查询原任务/下载结果，不提交生成 |

## 参数限制

兼容接口 size 为比例，默认 1:1；resolution 为 1k / 2k / 4k，默认 2k。4K 只支持 16:9、9:16、2:1、1:2、21:9、9:21；其他组合在提交前拒绝，让用户选比例或明确改为 2k，不静默降级。

官方 OpenAI quality 取 low / medium / high / auto，size 可用 1:1 / 2:3 / 3:2。Gemini 原生 image-size 为 512 / 1K / 2K / 4K；Grok 原生 resolution 为 1k / 2k。原生协议不支持的字段提交前报错，不静默丢弃。

## 维护 CLI 索引

优先使用上述交互脚本，setup 保留兼容/诊断命令：

| 参数 | 用途 |
|---|---|
| --profile / --base-url / --api-key / --family / --api / --output-dir / --activate | 旧式配置入口；有 Key 时优先改用 onboarding stdin，避免参数泄密 |
| --list / --activate-profile | 查看配置 / 切换默认配置 |
| --rename-profile / --to / --delete-profile | 重命名 / 删除明确目标；最后一项删除后回初始化 |
| --health-check / --live | 本地配置检查 / 在线可达性检查，不生图 |
| --sync-models / --list-models | 全量分页刷新 / 旧合并目录诊断 |
| --model / --profile-model / --primary-model / --fallback-model / --clear-fallback-models | 旧全局模型 / profile 主模型 / 一个可选备选 / 清除备选 |
| --add-model / --model-id / --label / --delete-model | 手动准确 ID 注册/删除；内置条目不可删除 |
| --image-field / --image-transport / --image-shape / --image-endpoint / --clear-image-options | 图生图适配与还原 |
| --uninstall-skill / --keep-config-file / --keep-keychain / --purge-logs | 清理本技能数据；按用户明确指定范围执行，默认保留图片与日志 |

## 输出与展示

请求多张但返回不足时，JSON status 为 partial，并包含 requested_count / received_count / missing_count；如实报告缺少张数，不自动补生成。

始终使用 --json 获取实际 model、profile、used_fallback_model、run_dir、images。成功使用备选时说明实际模型，不把持久首选改掉。逐张用 images 的 display 展示 URL 或本地绝对路径：`![生成的图片](display)`；多张完整展示。

默认保存到总目录下的时间子目录，带 meta.json；日志位于 ~/.oh-coage/runs.jsonl。下载失败时先展示已保存项并给恢复入口。日志可能含提示词，未经用户要求不上传或分享。
