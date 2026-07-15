# omp-provider-qoder

一个 [OMP](https://github.com/can1357/oh-my-pi) provider 扩展，将 omp 连接到 **Qoder API**，通过 provider 接口暴露 Qoder Global 和 Qoder China 模型。

## 功能特性

- **两个 provider 入口**：
  - `qoder` — 全球/国际版 Qoder。
  - `qoder-cn` — 中国版 Qoder，强制使用 CN 端点，不受 `QODER_REGION` 影响。
- **交互式登录**：Global Qoder 支持浏览器设备码流程或个人访问令牌（PAT）登录。
- **Qoder CN PAT 登录**：中国版使用独立的 PAT 登录入口（`/login qoder-cn`）和 CN token 交换端点。
- **WAF 绕过**：内置 WAF 混淆和请求体编码（`Encode=1`）。
- **COSY 签名**：完整的 COSY 签名头生成（RSA/AES-CBC/MD5）。
- **动态模型目录**：从 `/algo/api/v2/model/list` 端点动态获取模型限制、effort 配置和选项。
- **推理/思考支持**：从 API reasoning 或类 HTML `<think>` 标签中实时提取思考过程。

## 快速开始

安装 provider：

```bash
omp install npm:omp-provider-qoder
```

或通过 npm 全局安装：

```bash
npm install -g omp-provider-qoder
```

然后从 omp 登录。

全球/国际版：

```text
/login qoder
```

中国版：

```text
/login qoder-cn
```

### 个人访问令牌（PAT）

Qoder PAT（`pt-...`）不能直接用于 API 调用认证——provider 会将其交换为短期有效的 job token（模拟官方 `qodercli` / `qoderclicn` 流程），并自动解析您的账户身份。

Global Qoder：

- 运行 `/login qoder`，选择 **Use API Key (PAT)**，然后粘贴令牌。
- 或在启动 omp 前设置 `QODER_PERSONAL_ACCESS_TOKEN`（或 `QODER_PAT`）。

Qoder China：

- 运行 `/login qoder-cn`，然后粘贴 CN PAT。
- 或在启动 omp 前设置 `QODERCN_PERSONAL_ACCESS_TOKEN`（或 `QODERCN_PAT`）。

> 交换后的 job token 是短期有效的；provider 会在其过期时透明地重新交换已存储的 PAT。

### 区域环境变量

provider 还能识别以下可选变量：

```bash
export QODER_REGION=cn       # 或 QODER_BACKEND=cn / QODER_MODE=cn
```

在没有全局 PAT 的情况下设置 CN PAT 也会为 `qoder` 入口自动选择 CN 模式，但推荐的显式中国入口仍然是 `/login qoder-cn` 和 `--provider qoder-cn`。

## 端点

Global：

- PAT 交换：`https://openapi.qoder.sh/api/v1/jobToken/exchange`
- 用户信息：`https://openapi.qoder.sh/api/v1/userinfo`
- 用量查询：`https://openapi.qoder.sh/api/v2/quota/usage`
- 模型/聊天网关：`https://api3.qoder.sh/algo/api/v2/...`

China：

- PAT 交换：`https://openapi.qoder.com.cn/api/v1/jobToken/exchange`
- 用户信息：`https://openapi.qoder.com.cn/api/v1/userinfo`
- 用量查询：`https://openapi.qoder.com.cn/api/v2/quota/usage`
- 模型/聊天网关：`https://gateway.qoder.com.cn/algo/api/v2/...`

## 模型

### Global `qoder`

暴露 Qoder 返回的后端模型 key，包括：

- **层级模型**：`auto`、`ultimate`、`performance`、`efficient`、`lite`
- **前沿模型**：
  - `qmodel`（Qwen3.7 Plus）
  - `qmodel_latest`（Qwen3.7 Max）
  - `dmodel`（DeepSeek V4 Pro）
  - `dfmodel`（DeepSeek V4 Flash）
  - `gm51model`（GLM）
  - `kmodel`（Kimi）
  - `mmodel`（MiniMax）

### China `qoder-cn`

中国版 provider 暴露友好的模型 ID，并在请求时将其映射回 Qoder CN 的内部 key：

| 友好 ID | Qoder CN key | 上下文 | 图片 | 推理 |
| --- | --- | ---: | :---: | :---: |
| `auto` | `auto` | 180K | ✅ | ✅ |
| `qwen3.7-max` | `qmodel_latest` | 1M | ✅ | ✅ |
| `qwen3.7-plus` | `qmodel` | 1M | ❌ | ✅ |
| `qwen3.6-flash` | `q36fmodel` | 1M | ❌ | ✅ |
| `deepseek-v4-pro` | `dmodel` | 1M | ❌ | ✅ |
| `deepseek-v4-flash` | `dfmodel` | 1M | ❌ | ❌ |
| `glm-5.2` | `gm51model` | 200K | ✅ | ✅ |
| `kimi-k2.6` | `kmodel` | 256K | ✅ | ✅ |
| `minimax-m2.7` | `mmodel` | 200K | ❌ | ❌ |

同时还接受兼容性别名用于请求映射，例如 `qwen3.6-plus` → `qmodel`、`glm-5.1` → `gm51model`、`minimax-m3` → `mmodel`。

## 使用

登录后，在 omp 中选择任意 Qoder 模型：

```text
/model qwen3.7-plus
```

或直接启动：

```bash
omp --provider qoder-cn --model qwen3.7-plus
```

Global 示例：

```bash
omp --provider qoder --model auto
```

## 架构

```text
src/
├── index.ts            # 扩展注册
├── cosy.ts             # COSY 签名、机器 ID、区域/端点、CN 模型别名
├── login.ts            # OAuth 设备码流程 + PAT 登录序列
├── pat.ts              # PAT → job-token 交换 + 身份解析
├── models.ts           # 模型定义和动态配置缓存
├── oauth.ts            # PAT / OAuth 回调编排器
├── stream.ts           # 主流式响应处理器
├── transform.ts        # 消息转换（OpenAI 模式映射）
├── thinking-parser.ts  # 备选 `<think>` 标签解析器
└── qoder-encoding.ts   # WAF 绕过请求体编码器
```

## 许可证

MIT
