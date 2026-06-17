# oh-coage

一个给 Codex / Claude Code / 其他 AI coding agent 使用的图片生成 skill。

这个 skill 固定使用 `gpt-image-2` 模型，但不绑定某一家站点。它支持你在**首次使用时本地初始化**：

- 让用户先决定图片保存目录
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
      "output_dir": "/Users/you/Pictures/AI",
      "keychain_account": "main:abcd1234efgh"
    }
  }
}
```

不会把真实 `api_key` 写进这个文件。

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
- 调用该 profile 对应的 `base_url`
- 生成成功后自动保存到该 profile 的输出目录
- `stdout` 输出最终本地文件路径

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
  - 初始化或新增 profile 时，指定默认保存目录
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

## 多 profile 管理

### 查看已有 profile

```bash
node "$SKILL_DIR/scripts/setup.js" --list
```

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

### 3. 图片没有保存到预期目录

检查：

- 当前 active profile 是哪个
- 这次是否传了 `--profile`
- 这次是否传了 `--output` 或 `--out-dir`

### 4. 接口不是异步任务结构，能不能用

可以。当前脚本兼容：

- 提交任务后返回 `task_id`
- 直接返回图片 URL
- 直接返回 base64

### 5. 能不能支持多个站点和多个 key

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
