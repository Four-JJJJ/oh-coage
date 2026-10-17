# 高级参数使用示例

## 1. quality（图片质量）

控制生成图片的质量级别。

### 标准质量（默认）
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "a beautiful sunset over mountains" \
  --quality "standard"
```

### 高清质量
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "a beautiful sunset over mountains" \
  --quality "hd"
```

**说明：**
- `standard`：标准质量，生成速度快，成本低
- `hd`：高清质量，细节更丰富，但生成时间更长，成本更高

---

## 2. style（风格）

控制图片的视觉风格。

### 生动风格
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "a cat sitting on a chair" \
  --style "vivid"
```

### 自然风格
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "a cat sitting on a chair" \
  --style "natural"
```

**说明：**
- `vivid`：生动、鲜艳、夸张的风格，色彩饱和度高
- `natural`：自然、真实、低调的风格，更接近照片感

---

## 3. response-format（响应格式）

控制 API 返回图片的格式。

### 返回 URL（默认）
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "a red apple" \
  --response-format "url"
```

### 返回 Base64
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "a red apple" \
  --response-format "b64_json"
```

**说明：**
- `url`：API 返回图片的 URL 地址，脚本会自动下载并保存
- `b64_json`：API 返回 Base64 编码的图片数据，脚本会直接解码保存
- 两种格式对最终保存的本地文件没有影响，只是传输方式不同

---

## 4. user（用户标识）

用于追踪和滥用监控，帮助服务提供商识别和管理 API 使用。

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "a landscape painting" \
  --user "user-12345"
```

**说明：**
- 传入一个唯一的用户标识符
- 用于服务端的使用统计、滥用检测和费用追踪
- 通常在多租户系统或需要精细化管理的场景中使用

---

## 组合使用示例

### 示例 1：生成高质量、生动风格的宽屏壁纸
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "a futuristic city at night with neon lights" \
  --size "16:9" \
  --resolution "4k" \
  --quality "hd" \
  --style "vivid"
```

### 示例 2：自然风格的人像照片
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "portrait of a young woman in natural lighting" \
  --size "2:3" \
  --resolution "2k" \
  --quality "hd" \
  --style "natural"
```

### 示例 3：带用户追踪的标准生成
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "abstract geometric patterns" \
  --quality "standard" \
  --style "vivid" \
  --user "project-alpha-user-001" \
  --profile "production"
```

### 示例 4：快速草稿模式
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "quick concept sketch of a robot" \
  --resolution "1k" \
  --quality "standard" \
  --style "vivid"
```

### 示例 5：高质量图生图
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "turn this photo into an oil painting style" \
  --image-url "/path/to/reference.jpg" \
  --quality "hd" \
  --style "vivid"
```

---

## 参数组合建议

### 适合快速原型/草稿
```bash
--resolution "1k" --quality "standard"
```
- 生成速度快，成本低
- 适合快速验证想法

### 适合最终交付/打印
```bash
--resolution "4k" --quality "hd" --size "16:9"
```
- 最高质量
- 适合需要高分辨率的场景

### 适合插画/艺术创作
```bash
--style "vivid" --quality "hd"
```
- 色彩鲜艳，视觉冲击力强
- 适合海报、宣传物料

### 适合摄影/真实场景
```bash
--style "natural" --quality "hd"
```
- 真实感强，接近照片
- 适合产品展示、人像

---

## 注意事项

1. **quality 和 resolution 的区别**
   - `resolution`：控制图片的像素尺寸（1k/2k/4k）
   - `quality`：控制生成的细节和精细度（standard/hd）
   - 两者可以独立设置，通常高分辨率配合高质量效果最好

2. **成本考虑**
   - `quality: hd` 通常比 `standard` 更贵
   - `resolution: 4k` 比 `2k` 或 `1k` 更贵
   - 如果预算有限，优先保证 `quality`，再考虑 `resolution`

3. **style 的选择**
   - 如果不确定，先不传（使用默认）
   - `vivid` 适合需要吸引眼球的场景
   - `natural` 适合需要真实感的场景

4. **response-format 的使用**
   - 通常保持默认即可
   - 如果遇到某些站点的 URL 下载不稳定，可以尝试 `b64_json`

5. **user 参数**
   - 不是必需的
   - 如果你的系统需要追踪不同用户的使用情况，再使用此参数
   - 确保用户标识符的隐私性

---

## 实际场景示例

### 场景 1：为博客生成配图
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "a minimalist workspace with laptop and coffee" \
  --size "16:9" \
  --resolution "2k" \
  --quality "standard" \
  --style "natural"
```

### 场景 2：为社交媒体创建视觉内容
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "colorful abstract background for social media post" \
  --size "1:1" \
  --resolution "2k" \
  --quality "hd" \
  --style "vivid"
```

### 场景 3：为印刷品准备素材
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "elegant floral pattern for wedding invitation" \
  --size "2:3" \
  --resolution "4k" \
  --quality "hd" \
  --style "natural"
```

### 场景 4：快速生成参考图
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "layout concept for mobile app home screen" \
  --size "9:16" \
  --resolution "1k" \
  --quality "standard"
```
