# oh-coage

一个给 Codex / Claude Code / 其他 AI coding agent 使用的图片生成 skill。

这个 skill 固定使用 `gpt-image-2` 模型，但不绑定某一家站点。它支持你在**首次使用时本地初始化**：

- 让用户先决定图片总保存目录
- 让用户填写站点 `base_url`
- 让用户填写 `api_key`
- 把敏感的 `api_key` 存进 **macOS Keychain**
- 把非敏感配置写进用户指定目录下的本地配置文件
- 支持多个 profile 之间切换
- 支持文生图、图生图、同步返回接口、异步任务接口

## 功能概览

- 模型固定：`gpt-image-2`
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
├── SKILL.md
├── README.md
└── scripts
    ├── config-store.js
    ├── generate.js
    └── setup.js
```

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

把这个仓库作为 skill 安装到你的 agent skills 目录。

例如：

```bash
git clone https://github.com/Four-JJJJ/oh-coage.git
```

然后按你自己的 agent 规范，把它放到可触发的 skills 目录中。

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

应先询问用户这 4 个值：

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
/Users/you/Pictures/AI/oh-coage-config.json
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
      "root_output_dir": "/Users/you/Pictures/AI",
      "keychain_account": "main:abcd1234efgh"
    }
  }
}
```

不会把真实 `api_key` 写进这个文件。

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

如果上层 agent 收到的是本地图片路径，建议先把文件转为 base64 data URI 再传给脚本。

## 参数说明

### `generate.js`

```bash
node "$SKILL_DIR/scripts/generate.js" [options]
```

主要参数：

- `--prompt`
  - 必填，图片提示词
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
  - 与 `--health-check` 配合使用，增加一次低成本在线可达性探测

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
  --output-dir "/Users/you/Pictures/AI-backup" \
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
- 不删除 skill 仓库目录本身

如果你只想部分清理：

```bash
node "$SKILL_DIR/scripts/setup.js" --uninstall-skill --keep-config-file
```

```bash
node "$SKILL_DIR/scripts/setup.js" --uninstall-skill --keep-keychain
```

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

## 自动 fallback

生成图片时，脚本会按 profile 顺序尝试。

当前顺序规则：

- 先用当前 active profile
- 如果指定了 `--profile`，优先从该 profile 开始
- 其他 profile 作为后续候选

遇到下面这类错误，会自动切到下一个候选 profile：

- `502`
- `503`
- `504`
- `408`
- `429`
- 网络超时
- 连接重置或连接失败

其中：

- `429` 会先在当前 profile 上做短暂退避重试
- `401` / `403` 会直接判定该 profile 当前不可用

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
- 每次尝试的错误码 / 错误类型
- 最终是否成功
- 保存路径
- 总耗时

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

## License

按你的项目需要自行补充。
