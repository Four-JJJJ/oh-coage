# oh-coage

面向 Codex、Claude Code 等 Agent 的图片创作技能。使用你自己的服务地址和 API Key，支持文生图、参考图编辑、同步结果与异步任务。

初始化固定两步：连接服务 → 按厂家配置模型。可视化表单默认开启，文字会话兜底；全量拉取模型，按厂家各选一个主模型，备选可空。

请求协议默认使用 **OpenAI Images 生图格式**，发送到你填写的站点。模型厂家与请求协议独立：选择 Gemini 或 Grok 模型不会自动切换协议。需要原生协议时，在“更多设置 → 生图请求协议”中明确选择，或在对话中指定；原生连接仅使用对应厂家的模型，切换前确认地址和凭据。

## 安装方式

本仓库仅提供 skill 版本，可在 Codex、Claude Code 等支持本地技能的宿主中使用。

先把仓库克隆到本地固定位置：

```bash
git clone https://github.com/Four-JJJJ/oh-coage.git
```

**推荐做法**：把 `skills/oh-coage` 这个自包含目录软链到你的 agent skills 目录。这样 `$SKILL_DIR` 就指向 skill 实体，文档里的 `$SKILL_DIR/scripts/...` 天然正确。

Codex（个人技能目录）：

```bash
mkdir -p ~/.agents/skills
ln -s "/path/to/oh-coage/skills/oh-coage" ~/.agents/skills/oh-coage
```

Claude Code：

```bash
mkdir -p ~/.claude/skills
ln -s "/path/to/oh-coage/skills/oh-coage" ~/.claude/skills/oh-coage
```

请将 `/path/to/oh-coage` 替换为实际克隆路径。目标位置已有同名技能时，先检查现有安装，不要覆盖。也可以将 `skills/oh-coage/` 整个目录复制到宿主的 skills 目录。

**另一种做法**：把仓库根目录本身当作 skill 目录。此时根目录的 `SKILL.md` 只是入口指针，会把你导向 `skills/oh-coage/SKILL.md`；按该文件的说明，你需要把 `skills/oh-coage/` 视为 `$SKILL_DIR`。

安装只会获取技能代码。每位用户都需要在自己的机器上完成初始化并提供自己的站点地址和 API Key；密钥不会随仓库或配置文件分发。

技能模式同样支持 Codex 的可视化初始化表单；宿主同时支持 inline HTML 渲染和 `window.openai.sendFollowUpMessage` 时使用表单，否则通过聊天完成初始化。


## 日常怎么用

| 你想做的事 | 交互 |
|---|---|
| “帮我画…” | 使用默认厂家的主模型，符合条件时尝试同厂家备选 |
| “这张用 xxx 画” | 仅本次使用指定模型，不修改配置 |
| “切换模型 / 改成 xxx” | 确认主/备位置，打开完整厂家配置表单 |
| “这次用 Gemini” | 使用 Gemini 已保存的主备链，不改默认厂家 |
| “以后用 Gemini” | 表单设置默认厂家，保留其他厂家配置 |
| “管理模型” | 每家两个下拉框：一个主模型、一个可选备选 |
| “切换站点” | 已有配置选择，临时或设为默认，不再索取 Key |
| “刷新模型” | 完整分页拉取当前站点，失败保留原列表和配置 |
| “更新 Key/地址” | 编辑连接，验证并确认各厂主备后保存 |
| “取消设置 / 继续下载” | 退出本次设置 / 恢复原任务，不重新生图 |

主要规则和 CLI 入口见 [技能说明](skills/oh-coage/SKILL.md)，固定初始化文案见 [初始化流程](skills/oh-coage/references/onboarding.md)，完整分支与恢复出口见 [交互规则](skills/oh-coage/references/interaction.md)。

### 主备模型：首选 + 备用写在同一个 profile 里

OpenAI、Gemini、Grok 各有一个主模型与可选的一个备选。任意一家配置好主模型即可开始，其他厂家随时添加；无法识别的模型保留在“其他模型”。默认厂家独立选择，日常切换打开和初始化相同的完整表单，不需要重新填 Key。

配置保存为 profile.model_families 与 profile.active_model_family。profile.model / profile.fallback_models 镜像默认厂家，保留旧 --primary-model / --fallback-model 的兼容入口。旧混合配置读取时按厂家拆分，每厂第一项为主、下一项为备，多余旧备选不再执行，读取不改盘；正式保存才更新结构。

主模型明确不可用时最多尝试一个同厂家备选，仍失败就停止，不跨厂家；跨站点备选默认关闭。显式指定模型只尝试该模型。只有用户允许跨站点时才开启 --allow-profile-fallback。used_fallback_model 表示实际使用了备选项，不改变持久配置。

有 9 个内置模型供旧配置和简称解析使用；可选列表以当前站点真实返回为准，支持准确的自定义模型 ID。列表可见不等于出图能力或额度已验证。单次使用不写配置；临时表单只取所选厂家的主模型，不运行临时备选链。

## 结果与恢复

生成前检查输出目录；结果按任务保存，URL 和 base64 均可落盘展示。遇到超时、断线、408/5xx 或其他未知结果，停止自动生成提交；有任务 ID 则查询原任务，已有图片则只恢复下载，保留部分成功图片。余额或额度不足单独识别并停止重试。固定提示文案与恢复规则见 [错误处理](skills/oh-coage/references/errors.md)。

```bash
node "$SKILL_DIR/scripts/generate.js" --prompt "海边的灯塔" --json
node "$SKILL_DIR/scripts/generate.js" --resume "/path/recovery-xxx.json" --json
```

单次最多提交 3 次生成请求（包含安全重试和备选），不会自动扩大。恢复操作不发生成 POST；没有任务 ID 且结果未知时需核对服务商记录。停止本地等待不能保证取消服务端任务。

4K 支持比例为 16:9、9:16、2:1、1:2、21:9、9:21。不支持的组合在提交前报错，不自动降低画质。更多原生接口与参考图适配参数见技能说明与 examples/。

## 存储与保护

- Node.js >=20，安全存储依赖 macOS Keychain；不自动安装缺失依赖。
- API Key 存入本机钥匙串，配置文件只保存非敏感信息。表单通过当前对话传给本机脚本，不能承诺密钥不进入会话。
- 已有配置按版本保存，过期表单不能覆盖新改动；同一初始化提交重复执行不会多建配置。
- 删除最后一个配置后回初始化，图片与日志保留；删除/卸载只执行用户明确指定范围。
- 不同机器分别初始化自己的 Keychain；复制非敏感配置不等于密钥同步。
- 推荐软链安装，避免目录副本与源代码漂移。已安装副本应在检查差异后更新，不能覆盖个人额外文件。

## 开发与验证

```bash
npm run check
npm test
npm run test:regressions
```

测试使用独立临时 HOME、假钥匙串和本地 HTTP 模拟接口；不读取真实密钥，不写用户真实配置，不调用付费接口。安装包含代码，不包含配置、凭据或生成图片。

## Acknowledgements

致谢原始项目：[bozhouDev/images2-gen](https://github.com/bozhouDev/images2-gen)。

## License

本项目采用 MIT License，详见 [LICENSE](./LICENSE)。
