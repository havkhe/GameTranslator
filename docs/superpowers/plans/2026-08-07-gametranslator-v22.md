# GameTranslator v2.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 内置 llama.cpp CUDA 运行时并自动托管模型、移除联网/API 功能、扫描目标可选、模型动态检测、新增暂停/终止按钮，部署到 D:\GameTranslator 并推送 GitHub。

**Architecture:** C# WinForms UI 管理 llama-server 生命周期并通过 node 调用 game-pipeline.js；管线只请求本地 llama.cpp 的 OpenAI 兼容接口；flag 文件实现批间暂停/优雅终止。

**Tech Stack:** C# (.NET Framework WinForms, csc.exe)、Node.js、llama.cpp CUDA (llama-server)、Ruby（VX Ace 支持，不变）。

---

## 文件结构

- 修改：`game-pipeline.js`（去 API、连 llama、flag 控制）
- 修改：`GameTranslator.cs`（仓库根，从 work 移入并入库；UI/托管/settings）
- 创建：`download-llama.ps1`（下载 CUDA 版 llama.cpp 到指定目录）
- 创建：`deploy-to-d.ps1`（部署完整应用到 D:\GameTranslator）
- 修改：`使用说明.txt`
- 新建：`settings.json`（运行时生成，不入库）

## Task 1: 下载 llama.cpp CUDA 运行时

**Files:**
- Create: `download-llama.ps1`

- [ ] **Step 1: 写下载脚本**

```powershell
param([string]$Dest = "D:\GameTranslator\llama")
$ErrorActionPreference = "Stop"
$rel = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest" -Headers @{ "User-Agent"="Codex" }
$asset = $rel.assets | Where-Object { $_.name -match "bin-win-cuda-12\.4-x64\.zip$" } | Select-Object -First 1
if (-not $asset) { throw "未找到 CUDA 12.4 资产" }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile "$env:TEMP\llama-cuda.zip"
Expand-Archive -Path "$env:TEMP\llama-cuda.zip" -DestinationPath $Dest -Force
Get-ChildItem $Dest -Filter "*.exe" | Select-Object Name
```

- [ ] **Step 2: 运行脚本**（失败时按 AGENTS.md 启动 Clash 重试）

## Task 2: 修改 game-pipeline.js

**Files:**
- Modify: `game-pipeline.js`

- [ ] **Step 1: 参数与常量**：删除 MODE/API_* 参数，新增 `LLAMA_BASE`（默认 `http://127.0.0.1:18080`，argv[5] 覆盖），`WORK/PAUSE_FLAG/STOP_FLAG` 常量。
- [ ] **Step 2: 删除 `askApi`、`ask()` 分支**；`askLocal` 改为 llama.cpp `/v1/chat/completions`，body `{model:"local", messages:[{role:"user",content}], temperature:0.3, max_tokens:2048, stream:false}`，解析 `choices[0].message.content`。
- [ ] **Step 3: flag 控制**：`translate()` 开始时清理旧 flag；每批循环顶部调用 `checkFlags()`：

```js
function checkFlags() {
  while (fs.existsSync(PAUSE_FLAG)) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  if (fs.existsSync(STOP_FLAG)) {
    console.log("STOPPED_BY_USER");
    process.exit(0);
  }
}
```

- [ ] **Step 4: main 调用**：`node game-pipeline.js <gameDir> <model> <workDir> [port]`，不再传 mode/api。
- [ ] **Step 5: 校验**：`node --check game-pipeline.js`。

## Task 3: 重写 GameTranslator.cs

**Files:**
- Modify: `GameTranslator.cs`（仓库根）

- [ ] **Step 1: 删除 API 相关**：ApiConfig 类、cmbMode/txtApiBase/txtApiKey/txtApiModel/btnSaveApi、Load/SaveApiConfig、api-config.json 读写。
- [ ] **Step 2: settings.json**：`{ModelDir, Port}`；默认 `D:\galtrans` / 18080。
- [ ] **Step 3: 模型动态检测**：`LoadModels()` 递归扫描 ModelDir 下 `*.gguf`，ComboBox 显示文件名，Dictionary 保存全路径。
- [ ] **Step 4: llama 托管**：`EnsureLlama(path)`（启动/复用/切换重启 + 轮询 `/health`）、`KillLlama()`、`FormClosed` 停止。
- [ ] **Step 5: 扫描目标**：盘符下拉 + “扫描” + “选择文件夹”（FolderBrowserDialog）。
- [ ] **Step 6: 暂停/终止**：写/删 `work\pause.flag`、写 `work\stop.flag`；按钮状态管理。
- [ ] **Step 7: TranslateGame**：调用 `EnsureLlama` 后执行 `node game-pipeline.js "<dir>" <model> "<work>" <port>`。
- [ ] **Step 8: 编译**：

```powershell
& "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /codepage:65001 /target:winexe /out:GameTranslator.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll GameTranslator.cs
```

## Task 4: 部署到 D:\GameTranslator

- [ ] **Step 1: 写 `deploy-to-d.ps1`**：复制 exe、game-pipeline.js、rgss3a.js、ruby\、使用说明.txt、download-llama 结果；删除旧 api-config.json；写入默认 settings.json。
- [ ] **Step 2: 运行部署脚本**；确认 D:\GameTranslator 结构。

## Task 5: 端到端验证

- [ ] **Step 1**: `node --check`、`ruby -c`、csc 编译通过。
- [ ] **Step 2**: 启动 llama-server 加载 `D:\galtrans` 某模型，`/health` 就绪，curl 一次 `/v1/chat/completions` 成功。
- [ ] **Step 3**: 运行 GUI 手动验证：模型列表、扫描盘/文件夹、暂停/终止按钮、退出停止服务器。

## Task 6: 提交与推送

- [ ] **Step 1**: 更新使用说明 v2.2；git add（含 GameTranslator.cs、脚本、pipeline、文档）；commit `GameTranslator v2.2: 内置llama自动托管、移除API、动态模型/扫描、暂停终止`。
- [ ] **Step 2**: `git push origin main`；确认 GitHub 最新提交。
