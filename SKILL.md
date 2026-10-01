---
name: oh-coage
description: 使用可配置站点的 GPT-Image 系列 API 生成图片，支持文生图和图生图，并可在 gpt-image-2 / gpt-image-2.5-sunburst / gpt-image-2.5-flare 三个内置模型间切换或自定义模型。当用户说"生图"、"画图"、"生成图片"、"oh-coage"、"gpt-image"、"Image2 生图"、"帮我画"、"用 gpt 画"、"用 2.5 画"、"换个模型画"、"把这张图改成"、"参考这张图"等涉及 AI 图片生成或图片编辑的请求时触发此技能。首次使用时先做本地初始化：收集图片总保存目录、profile 名、站点 URL 和 API Key；支持聊天问答和可视化表单两种初始化方式；Key 写入本机 Keychain，本地配置文件只保存非敏感信息。
---

# oh-coage（入口指针）

本文件只是入口，**故意不含流程正文**，以免与真正的文档产生两份互相漂移的副本。

**唯一权威文档：**

```text
$SKILL_DIR/skills/oh-coage/SKILL.md
```

命中本技能后，**先完整读取上面这份文档，然后严格按它的流程执行**。所有初始化、生成、profile 管理、fallback 的规则都以那份为准。

## 脚本位置

本仓库是「仓库根目录即 skill 目录」的安装方式，脚本在：

```bash
node "$SKILL_DIR/skills/oh-coage/scripts/setup.js"    # 初始化与 profile 管理
node "$SKILL_DIR/skills/oh-coage/scripts/generate.js" # 生成图片
```

请注意：读取 `skills/oh-coage/SKILL.md` 时，**要把 `skills/oh-coage/` 视为那份文档里的 `$SKILL_DIR`**，而不是本仓库根目录。否则其中的 `$SKILL_DIR/scripts/...` 会解析错。

如果安装方式本来就是「`skills/oh-coage/` 即 skill 目录」（Codex 插件安装，或把该子目录单独软链到 skills 目录），那就不需要本文件，直接用那份文档即可，其中 `$SKILL_DIR/scripts/...` 天然正确。

不要在本文档里补充任何流程说明。
