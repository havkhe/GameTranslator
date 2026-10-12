# 10 系显卡（Pascal / GTX 10 系）的 CUDA 支持

这个分支是给 **GTX 10 系（Pascal, sm_61）** 用户看的入口。结论先说：

**CUDA 版在 10 系显卡上能跑，而且不需要老版本的 CUDA。**
以前说明书写过"CUDA 12 预编译包不支持 GTX 10 系、会静默退回 CPU"——**那句是错的**，已在本分支更正。

## 一、为什么说"能跑"：三条实测证据

1. 包内 CUDA 构建的 `ggml-cuda.dll`（545.8 MB）里，fatbin 的架构标记是
   `sm_50 / sm_61 / sm_70 / sm_75 / sm_80 / sm_90` —— **sm_61（Pascal）就在里面**；
2. `llama-cli.exe --list-devices` 输出 `CUDA0: NVIDIA GeForce GTX 1060 6GB`，
   加载日志写明 `compute capability 6.1`；
3. `llama-bench` 在 CUDA 上跑出 601 t/s 的预填充，**没有静默退回 CPU**（退回 CPU 只会有个位数）。

驱动要求：CUDA 12.4 构建需要较新的 NVIDIA 驱动（实测 582.66 可用）。

## 二、但"更快"要看模型：GTX 1060 6GB 实测

`-ngl 99`，同一张卡、同一个模型，只换后端：

| 模型 | 后端 | 读入 pp256 | 生成 tg | 谁快 |
|---|---|---|---|---|
| Hy-MT2 **1.8B Q8_0** | CUDA | **1451 t/s** | **46.3 t/s** | CUDA 明显更快 |
| | Vulkan | 367 t/s | 28.3 t/s | |
| Galtransl-v4 **4B Q6_K** | CUDA | **601 t/s** | 25.5 t/s | 生成反而 Vulkan 快 |
| | Vulkan | 257 t/s | **38.2 t/s** | |
| Qwen3.5 **4B Q4_K_M** | CUDA | **595 t/s** | 27.1 t/s | 生成反而 Vulkan 快 |
| | Vulkan | 276 t/s | **37.3 t/s** | |

（生成速度用 `-n 256` 复测过，结论不变。）

**规律**

- **CUDA 在"读入（预填充）"上快 2~4 倍**——输入越长，这个优势越值钱。
- **"生成（出译文）"这一步**：`Q8_0` 这类量化 CUDA 更快；而 **4B 的 K 量化（Q4_K/Q6_K）Vulkan 更快**。
- 原因在 Pascal 本身：没有 tensor core、FP16 只有 1/64 速率，K 量化在 CUDA 上要走反量化；
  Vulkan 用的是整数点积（`int dot: 1`）。
- 翻译的批是"长输入 + 差不多长的输出"，所以用 4B K 量化时 **Vulkan 端到端反而快 20~50%**；
  用 1.8B Q8_0 或输入特别长时，CUDA 更划算。

**所以别猜，跑一局看数**：界面上有 tok/s 与条/分，切过去翻同一款游戏对比即可。

## 三、怎么用（两套在同一个包里，离线切换）

1. 程序里模型那一行最右边的 **「后端：Vulkan / 后端：CUDA 12」** 按钮，点一下就切；
   空闲时会自动重启模型服务，**翻译进行中会拒绝**（避免打断正在跑的那一批）。
2. 或者不开程序：根目录双击 **`切换显卡后端.bat`**，或执行
   `.\switch-backend.ps1 -Backend vulkan|cuda12`。
3. 当前用的是哪一套，程序状态行（「模型：… 端口：…」那一行）末尾会写出来。
4. 某一套被删了：程序里的「后端：…」按钮能把它重新下载回来，或
   `.\download-llama.ps1 -Dest .\llama\cuda12 -Backend cuda12`。

两套分别放在 `llama\vulkan\` 与 `llama\cuda12\`，互不覆盖；CUDA 那套自带 `cudart64*.dll` 与 cuBLAS。

## 四、包里那套 CUDA 二进制是哪来的

llama.cpp 官方预编译发行版 `b11571` 的原始文件（**未经改动**，MIT，© ggml authors），
下载后按上游 GitHub API 的 `digest` 逐字节核对 sha256 才装进包：

```
llama-b11571-bin-win-cuda-12.4-x64.zip   sha256 2b865050b34271c2c35d2ebc6021845670de799c6a1cc4e78bcfbc43cedf649a
cudart-llama-bin-win-cuda-12.4-x64.zip   sha256 8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6
```

上游页面：<https://github.com/ggml-org/llama.cpp/releases/tag/b11571>

## 五、这套支持改了什么

- `ui/MainForm.cs`：把原来"10 系用不了 CUDA"的警告改成"能跑，但不一定更快"，
  分类逻辑抽成两个纯函数 `NameLooksLikeNvidia` / `NameLooksLikeModernNvidia`；
- `ui/UiCheck.cs`：新增 11 条断言（GTX 1060/970/1650/1660S、RTX 3060/4090、Intel 核显、A 卡、空名），
  合计 **282 项全部通过**；
- 手册与发行说明：更正 Pascal 说法并附上本页的实测对照表；
- `download-llama.ps1` / `switch-backend.ps1`：提示文案同步更正。

细节与完整记录见 `docs/P41-显卡后端切换.md` 第六节。
