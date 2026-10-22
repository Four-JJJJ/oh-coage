# 图生图（图片生成图片）适配示例

本文件演示 `oh-coage` 的图生图能力，以及怎么把它接到各种站点的接口写法上。

## 1. 最小用法

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "把这张图改成水彩风格" \
  --image-url "/path/to/photo.png"
```

`--image-url` 可重复传入多张；支持本地路径、`http(s)` URL、`data:image/...;base64,...`。
本地文件会自动读盘并转成 data URI 上传。

支持的本地格式：`png`、`jpg`、`jpeg`、`webp`、`gif`。

---

## 2. 默认发出去的请求长什么样

不配任何适配项时，行为是历史默认：

```http
POST {base_url}/images/generations
Content-Type: application/json
Authorization: Bearer {key}

{
  "model": "gpt-image-2",
  "prompt": "把这张图改成水彩风格",
  "n": 1,
  "size": "1:1",
  "resolution": "2k",
  "image_urls": ["data:image/png;base64,..."]
}
```

**只认 `image_urls` 字符串数组的中转站，什么都不用配。**

---

## 3. 站点要 multipart 文件上传

OpenAI 官方 `/images/edits`、以及多数改图接口，认的是文件字段而不是 URL 数组：

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "把这张图改成水彩风格" \
  --image-url "/path/to/photo.png" \
  --image-transport multipart
```

发出的请求变成：

```http
POST {base_url}/images/edits
Content-Type: multipart/form-data; boundary=----ohcoage...

------boundary
Content-Disposition: form-data; name="prompt"

把这张图改成水彩风格
------boundary
Content-Disposition: form-data; name="model"

gpt-image-2
------boundary
Content-Disposition: form-data; name="image"; filename="reference-1.png"
Content-Type: image/png

<PNG 二进制>
------boundary--
```

注意：

- 端点自动从 `/images/generations` 换成 `/images/edits`
- 字段名自动从 `image_urls` 换成 `image`
- 多张参考图时字段名变成 `image[]`（OpenAI 官方约定）
- **multipart 只支持本地文件或 data URI**。传远程 URL 会直接报错：

  ```text
  错误：multipart 图生图只能上传本地图片或 data URI。当前第 1 张参考图是远程 URL，
  请先下载到本地，或改用 --image-transport json。
  ```

---

## 4. 字段名不同

站点用 `images: [{url: ...}]`：

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "改成赛博朋克风" \
  --image-url "/path/to/photo.png" \
  --image-field images
```

发出 `"images": [{"url": "data:image/png;base64,..."}]`。
`images` / `input_images` / `reference_images` 这几个字段名会自动用对象数组形状。

站点用单张字符串 `image_url`：

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "改成线稿" \
  --image-url "/path/to/photo.png" \
  --image-field image_url --image-shape single
```

发出 `"image_url": "data:image/png;base64,..."`。

站点用自定义字段名（不认识的也照发）：

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "改成油画" \
  --image-url "/path/to/photo.png" \
  --image-field my_reference
```

---

## 5. 端点不同

改图接口不在 `/images/generations`：

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "换成像素风" \
  --image-url "/path/to/photo.png" \
  --image-field image \
  --image-endpoint /image/edit
```

`--image-endpoint` 也接受完整 URL，适合生图和改图分属不同网关：

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "换成像素风" \
  --image-url "/path/to/photo.png" \
  --image-endpoint "https://edit-gateway.example.com/v1/images/edits"
```

---

## 6. 存进 profile，之后不用每次传

```bash
# 该站点要 multipart 文件上传
node "$SKILL_DIR/scripts/setup.js" --image-transport multipart

# 字段名 + 形状
node "$SKILL_DIR/scripts/setup.js" --image-field image_url --image-shape single

# 端点也一起
node "$SKILL_DIR/scripts/setup.js" --image-field image --image-endpoint /image/edit

# 指定别的 profile
node "$SKILL_DIR/scripts/setup.js" --profile backup --image-transport multipart

# 清除，回到内置默认
node "$SKILL_DIR/scripts/setup.js" --clear-image-options
```

初始化时也能一次配好：

```bash
node "$SKILL_DIR/scripts/setup.js" \
  --profile relay \
  --base-url "https://relay.example.com/v1" \
  --api-key "KEY" \
  --image-transport multipart \
  --activate
```

用 `setup.js --list` 确认当前配置：

```text
* relay (openai / OpenAI 兼容接口) -> https://relay.example.com/v1 -> ~/Pictures/oh-coage [图生图: 端点=/images/edits, 传输=multipart, 字段=image, 形状=字符串数组]
```

---

## 7. 优先级

```
generate.js 参数  >  profile 配置  >  内置默认
```

比如 profile 存了 `json`，本次临时想试 `multipart`：

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "试一下" \
  --image-url "/path/to/photo.png" \
  --image-transport multipart
```

反过来也行——profile 是 `multipart`，本次传 `--image-transport json` 就只改这一次。

---

## 8. 排查 400

生成时 stderr 一定会打印这行：

```text
参考图片: 1 张；适配: 端点=/images/edits, 传输=multipart, 字段=image, 形状=字符串数组
```

按顺序对照：

| 报错线索 | 大概率是 | 怎么改 |
|---|---|---|
| `404` / `Not Found` | 端点不对 | `--image-endpoint` |
| `Unsupported content type` / 表单相关 | 传输方式不对 | `--image-transport multipart` 或 `json` |
| `Missing required parameter: xxx` | 字段名不对 | `--image-field xxx` |
| 类型错误（期望数组/期望字符串） | 形状不对 | `--image-shape array` / `array-object` / `single` |
| `Invalid image` / 图片解码失败 | 站点不收 data URI | 改 `--image-transport multipart` |

不确定站点认哪一种时，先保持默认跑一次；默认那套对多数中转站有效。

---

## 9. 官方接口

`api=official` 的 OpenAI 官方接口给参考图时会自动走 `/images/edits` + multipart：

```bash
node "$SKILL_DIR/scripts/generate.js" \
  --family openai --api official \
  --prompt "改成水彩风格" \
  --image-url "/path/to/photo.png" \
  --size 1:1 \
  --quality high
```

Gemini / Grok 官方接口的参考图走各自原生协议，不受这几个适配参数影响。
