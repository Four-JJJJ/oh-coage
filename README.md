# GPT-Image-2 Skill

This is a skill for AI coding agents (Claude Code, Codex, etc.) that enables GPT-Image-2 image generation via the DragonCode API.

## Installation

Install this skill into your agent's skill directory:

```bash
# Claude Code
/install-skill https://github.com/bozhouDev/images2-gen

# Or manually clone to your agent's skill directory
git clone https://github.com/bozhouDev/images2-gen.git gpt-image
```

## Setup Instructions (for the agent)

After installation, when the user triggers this skill for the first time, you must guide them through setup:

### Step 1: Check Node.js

Run `node -v`. If it fails, tell the user to install Node.js from https://nodejs.org/ before proceeding.

### Step 2: Check config file

Check if `~/.dragoncode/config.json` exists and contains a valid `api_key`.

If the config does not exist or `api_key` is empty, instruct the user to:

1. Go to https://dragoncode.codes/keys to create an API Key
2. Run one command to save it:

**macOS / Linux:**
```bash
mkdir -p ~/.dragoncode && echo '{"api_key":"PASTE_YOUR_KEY_HERE"}' > ~/.dragoncode/config.json
```

**Windows PowerShell:**
```powershell
mkdir -Force "$env:USERPROFILE\.dragoncode" | Out-Null; '{"api_key":"PASTE_YOUR_KEY_HERE"}' | Set-Content "$env:USERPROFILE\.dragoncode\config.json"
```

Once configured, this step is skipped in future invocations.

### Step 3: Generate images

Run the generate script:

```bash
node "<skill-dir>/scripts/generate.js" --prompt "the user's prompt" --size "1:1" --resolution "2k"
```

The script submits an async task, polls until completion, and prints the image URL to stdout. Progress is printed to stderr.

## Trigger phrases

Activate this skill when the user says anything related to AI image generation, such as:

- "生图" / "画图" / "生成图片" / "帮我画"
- "gpt-image" / "Image2 生图" / "用 gpt 画"
- "generate an image" / "create a picture"

## Parameters

| Param | Default | Description |
|---|---|---|
| `--prompt` | (required) | Image generation prompt |
| `--size` | `1:1` | Aspect ratio. Supported: `auto`, `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `5:4`, `4:5`, `16:9`, `9:16`, `2:1`, `1:2`, `21:9`, `9:21` |
| `--resolution` | `2k` | Output resolution: `1k`, `2k`, `4k` |

**4K restriction:** `4k` only works with `16:9`, `9:16`, `2:1`, `1:2`, `21:9`, `9:21`. The script auto-downgrades to `2k` for incompatible ratios.

## How to choose parameters

- User wants widescreen/landscape → `--size 16:9`
- User wants portrait/phone wallpaper → `--size 9:16`
- User wants poster → `--size 2:3`
- User says "高清" or "4K" → `--resolution 4k`
- User says "快速" or "省钱" → `--resolution 1k`
- No preference → use defaults (`1:1`, `2k`)
