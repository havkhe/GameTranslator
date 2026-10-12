# P30 —— 云端 API 翻译跑不起来的三个真因（2026-10-12 实测）

生成时间：2026-10-12
分支：`v3-p1`
改动文件：`pipeline/translate/client.js`、`ui/MainForm.cs`、`ui/UiCheck.cs`、`tools/unit-api-mode.js`
单测：`tools/unit-api-mode.js` 33 → **55 项**
UiCheck：155 → **156 项**
实测脚本：`（施工脚本目录）` —— `api-probe.js`（只读探测）、`api-probe2.js`（请求形状对照）、`api-live.js`（**直接驱动出货的 `client.js`** 打通真接口）

---

## 一、结论：三个各自独立的 bug，任何一个都足以让整轮"0 条"

用你的 key 对 `https://dashscope.aliyuncs.com/compatible-mode/v1` 实测，按触发顺序：

| # | 症状 | 根因 | 后果 |
|---|---|---|---|
| 1 | `read ECONNRESET`，每条请求都失败 | `client.js` 只 `require("http")`，**对 https 端点发明文请求**（打 443 端口的 TLS 服务） | **整轮 100% request-failed，一条都译不出** |
| 2 | `400 Role must be in [user, assistant].` | 云端请求固定带 `system` 角色，而 `qwen-mt-*` 系列不接受 | 链首是 `qwen-mt-plus` 时整轮失败 |
| 3 | 推理模型可能只回思考、不回正文 | 云端从没发过关闭思考的参数 | 白烧额度，还可能空回复 |

第 1 条是"**完全跑不起来**"的直接原因：GUI 的「刷新列表」能出模型（那是窗口自己在 C# 里用 `HttpWebRequest` 拉的），所以看起来接口是通的，但管线里每一条请求都在 TCP 层被重置。第 2 条是修好第 1 条之后立刻会撞上的第二堵墙——`qwen-mt-plus` 恰好是**模型链的第一项**，也是官方推荐的翻译模型。

---

## 二、实测证据（`api-probe2.js`，同一段日文，逐个模型 × 逐个请求形状）

| 模型 | 带 system 角色 | 不带 system（人设折进 user） | 带 `enable_thinking:false` |
|---|---|---|---|
| `qwen-mt-plus` | ❌ 400 `Role must be in [user, assistant]` | ✅ 200，译文正确 | ✅ 200（参数被忽略） |
| `qwen-mt-flash` | ❌ 400 同上 | ✅ 200 | ✅ 200 |
| `qwen-mt-lite` | ❌ 400 同上 | ✅ 200 | ✅ 200 |
| `qwen-mt-uni` | ❌ 400 `missing required field: input.target_lang`（原生格式，聊天接口驱动不了） | ❌ 同样 | ❌ 同样 |
| `qwen-plus` | ✅ 200 | ✅ 200（译文一致） | ✅ 200 |
| `qwen-turbo` | ✅ 200 | ✅ 200（译文一致） | ✅ 200 |
| `qwen-max` | ✅ 200 | ✅ 200 | ✅ 200 |
| `qwen-mt-turbo` | ❌ 404 `Model not exist.`（**该账号没有这个模型**） | — | — |

两处措辞值得记住：**是 `Model not exist.`，不是 `does not exist`**，旧判据（`does\s*not\s*exist`）因此漏判；`qwen-mt-uni` 根本不在 `/models` 的语义里（它要原生 `input.target_lang` 结构）。

## 三、改了什么（都在 `pipeline/translate/client.js`）

1. **传输层按协议选模块**：新增 `transportFor(protocol)`，`ask()` 与 `listModels()` 都用它。
   https → `https` 模块，http → `http` 模块。
2. **云端不发 `system` 角色**：人设句折进唯一的 `user` 消息（`SYSTEM_PROMPT + "\n\n" + prompt`）。
   对 `qwen-plus/turbo/max` 实测译文与带 system 时**完全一致**，还省 5 个 prompt token；
   **本地路径一字未改**（仍发 system + `chat_template_kwargs`），单测里两条都断言了。
3. **云端默认关思考**：请求体带顶层 `enable_thinking:false`（这是百炼兼容模式的写法，
   `chat_template_kwargs` 是 llama.cpp 扩展，两者不能混用）。模型若明确拒绝该参数
   （400 `NotSupportEnableThinking`），则**进程内去掉它并重试同一条请求**，日志打
   `API_THINK_FLAG_OFF …`——绝不因为一个设置项把整条译文记成失败。
4. **放宽"模型不可用"判据**：`Model not exist.`、`missing required field: input.*` 都算，
   于是 `qwen-mt-turbo`（账号没有）和 `qwen-mt-uni`（格式不符）会自动跳到链上下一个模型。
   角色报错**故意不算**——它靠请求形状解决，不是靠换模型；`401 / InvalidApiKey` 仍照旧不换模型、不重试。
5. **模型列表再排除语音对语音家族**：`realtime` / `livetranslate` / `s2s`
   （`qwen3-livetranslate-flash`、`qwen3.8-omni-flash-realtime`、`qwen3-s2s-flash-realtime` …）——
   它们吃音频、翻不了文本。`ui/MainForm.cs` 的 `NonChatModel` 同步加了这三个词。

## 四、验证（`api-live.js`：直接 `require` 出货的 `client.js`，走你的真 key）

```
=== 窗口真实的链：qwen-mt-plus,qwen-mt-turbo,qwen-plus,qwen-turbo,qwen-max ===
  用时 0.6 秒
  译文：
    1. 早上好，今天也精神十足呢。
    2. 你好，天气真不错啊。
    3. 谢谢，明天见。
  累计用量：{"requests":1,"prompt":167,"completion":32,"total":199}

=== 链首是账号里没有的模型：qwen-mt-turbo,qwen-mt-plus,qwen-plus ===
API_MODEL_SWITCH qwen-mt-turbo -> qwen-mt-plus   （…该端点不认识这个模型名，继续用 qwen-mt-plus 翻译）
  用时 1.0 秒   ✅ 译出

=== 原生格式模型：qwen-mt-uni,qwen-mt-plus ===
API_MODEL_SWITCH qwen-mt-uni -> qwen-mt-plus     ✅ 译出

=== 思考类模型：qwen3.8-flash ===
  用时 0.8 秒   ✅ 译出（enable_thinking:false 被接受）
```

也就是说：**修之前链首必挂，修之后四种情形（正常 / 模型不存在 / 格式不符 / 思考类）全部译出**。

单测：`tools/unit-api-mode.js` **55/55**（新增 22 项：传输层选模块、`https` 断言、系统角色禁令下的成功与请求体形状、
云端默认带 `enable_thinking:false`、拒绝该参数时的去掉重试与"后续请求也不再带"、
`Model not exist.`/原生格式算模型不可用、角色报错与密钥报错**不算**、本地路径仍发 system 与 `chat_template_kwargs`）。
其余 15 套全绿。UiCheck **156/156**（新增：语音对语音模型不出现在云端列表里），在 `（部署目录）` 用部署自身源码构建后运行。

## 五、部署状态与你要做的事

- 部署目录已同步：`pipeline/translate/client.js`（唯一改动的管线文件）。
- **`GameTranslatorV3.exe.new` 已暂存**（新 exe 里是界面侧的列表过滤改动）。旧 exe 备份为
  `GameTranslatorV3.exe.old-20261012-1438`。**因为程序正在跑翻译任务，没有替换**——按规矩留给
  `应用新版本.bat`：**终止任务 → 关掉程序 → 双击 `应用新版本.bat`**。
- 顺带一提：**只是管线修复的话，退出程序不是必需的**——`终止` 之后重新开始，新的管线进程就会读到你需要的
  修好的 `client.js`。要生效的只是界面上的列表过滤时，才需要应用新 exe。
- 正在跑的那一局（`Bitch Dancer's Quest`）是在修复前启动的，进程里加载的是旧 `client.js`，
  **它的每一条请求都在 TCP 层被重置，注定一条也译不出**，`work\` 下连 `-translations.json` 都还没生成。
  建议直接终止后重跑。
