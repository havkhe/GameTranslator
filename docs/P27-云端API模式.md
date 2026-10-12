# P27 —— 云端 API 模式：用 API Key 代替本地模型（含自动识别模型与额度用尽自动换模型）

生成时间：2026-10-12
分支：`v3-p1`
新增单测：`tools/unit-api-mode.js`（21 项，用本机进程内的假端点，不联网、不含任何密钥）
UiCheck：144 → **153 项**

---

## 一、能用了

翻译现在有两种后端，在【设置…】里切换：

1. **本地 llama**（原有行为，默认）
2. **云端 API**：任何 OpenAI 兼容接口（`{base}/chat/completions`）。已按你的 key 类型预填了
   **阿里云百炼**的入口 `https://dashscope.aliyuncs.com/compatible-mode/v1`——`sk-ws-` 是百炼的
   按量付费 Key，**一个 key 可调多个模型、每个模型各自有独立免费额度**。

云端模式做了三件你点名要的事：

- **自动识别模型**：点「刷新列表」会读接口的 `GET /models`，把可用模型填进下拉框（不是写死的清单）。
- **免费额度用完自动换模型**：接口返回 `403 AllocationQuota.FreeTierOnly` 时，自动切到模型链里的下一个，
  **并且重试同一条请求**——所以批次里不会有条目因为换模型而变成"未翻译"。
- **限流不拆批**：`429 / 5xx` 在请求层退避重试（有 `Retry-After` 就按它等），
  而不是像以前那样把整批拆小、把限流敲得更狠。

## 二、怎么用（3 步）

```
设置… → 云端 API 区域
   ☑ 使用云端 API（不再用本地 llama）
   接口地址：https://dashscope.aliyuncs.com/compatible-mode/v1     ← 默认
   API Key ：（粘贴你的 key）
   模型链  ：qwen-mt-plus,qwen-mt-turbo,qwen-plus,qwen-turbo,qwen-max  ← 默认，可改
→ 保存 → 模型下拉框点「刷新列表」→ 选一个模型 → 开始汉化
```

- **模型链**的含义：按顺序尝试；第一个的免费额度用完了就换第二个，依此类推。`qwen-mt-plus`
  是通义专门的翻译模型，通常最合适。
- 云端模式下「启动模型 / 停止模型」不可用（没有本地服务要起），状态行显示
  **「状态：云端 API（模型名）」**，速度行显示 **条/分**（云端没有本地 token 计数，不再假装 0.0 tok/s）。

## 三、密钥放在哪（安全）

| 位置 | 说明 |
|---|---|
| `api-config.json`（程序目录） | 设置里保存时写到这里；**`.gitignore` 已忽略**，不进版本库 |
| 环境变量 `GT_API_KEY` | 优先于文件；适合脚本化/便携安装，不落盘 |

**源码、示例、单测里都没有任何可用密钥**：单测里的"key"是运行时拼出来的占位串，测试也只用本机进程内的
假端点。密钥通过**环境变量传给管线子进程**（不是命令行参数，所以不会出现在进程列表里）。

## 四、实现要点

- `pipeline/translate/client.js`：统一的 `endpoint()`（本地 / 云端）、`listModels()`、`isQuotaExhausted()`；
  云端模式的鉴权、退避重试、换模型都在这一层，**调用方（批次、拆批、缓存）完全不用改**——这也是
  "换模型不影响批次"的实现方式。
- `ui/Settings.cs`：`UseApi / ApiBaseUrl / ApiModel / ApiModels` 存 ini（可读可改），密钥单独存
  `api-config.json`。
- `ui/MainForm.cs`：设置对话框新增一区；`RefreshApiModels()` 拉取模型列表；`BuildModelChain()`
  拼出链（选中项在前、去重）；`EnsureModelReadyAsync()` 把三个变量塞进子进程环境；
  状态行/速度行按模式分支。
- `ui/PipelineRunner.cs`：`ExtraEnv` 交给 `ProcessStartInfo.EnvironmentVariables`。

## 五、验证

- `tools/unit-api-mode.js`（**21 项**，全部通过）：模式判定只看环境变量；额度 403 → 换模型 + 同请求重试；
  换过去之后后续请求沿用新模型；额度全用尽 → 明确报错（含"进度都在缓存里"）；429 重试且不换模型；
  `GET /models` 解析；**本地模式完全不受影响**（仍打 127.0.0.1:port、仍用 `model: local`、不带 Authorization）。
- 其余 15 个套件全绿（合计 88 项断言 + 各套件自身计数）。
- UiCheck 144 → **153 项**（新增：模型链去重顺序、云端状态行、密钥文件写入/读回、密钥不在 ini 里）。

## 六、安全提醒（重要）

你那条 key **已经明文出现在本次对话里**（聊天记录/日志），建议：
**去百炼后台把这个 key 重置一次**，然后把新的 key 填进程序的设置里（或设成 `GT_API_KEY`）。
程序本身不会再把它写到任何会被提交的地方。
