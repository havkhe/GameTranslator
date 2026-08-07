# GameTranslator v2.2 设计文档（2026-08-07）

## 目标

1. 内置 llama.cpp CUDA 运行时，自动托管模型加载，不再依赖 Ollama。
2. 删除全部联网翻译 / API 相关功能。
3. 扫描目标由固定 `K:\` 改为可选择的盘符或文件夹。
4. 模型下拉动态检测模型目录中的 `*.gguf`（默认 `D:\galtrans`，可配置其他目录）。
5. 新增“暂停 / 继续”与“终止”按钮。
6. 部署到 `D:\GameTranslator` 日常使用；C 盘保留 Git 仓库，v2.2 同步提交并推送 GitHub。

## 架构

- `GameTranslator.exe`：C# WinForms UI（源码 `GameTranslator.cs` 入库，用 .NET Framework csc 编译）。
- `llama\`：内置 llama.cpp CUDA 版运行时（`llama-server.exe` + CUDA DLL，约 1GB，从 GitHub Releases 下载解压）。
- `game-pipeline.js`：汉化管线，只连接内置 llama 的 OpenAI 兼容接口。
- `rgss3a.js` / `ruby\`：VX Ace 支持，保持不变。
- `settings.json`：保存模型目录、llama 端口等配置（替代 `api-config.json`）。
- `work\`：翻译进度缓存 + 控制 flag（`pause.flag` / `stop.flag`）。

## 翻译流程（自动托管）

1. 点“开始汉化”时，若 llama-server 未运行或已加载模型与所选不同：
   - 停止旧服务器（如有）；
   - 启动 `llama-server.exe -m <model.gguf> --host 127.0.0.1 --port <port> -c 4096 -ngl 99`（隐藏窗口）；
   - 轮询 `/health` 直至就绪（超时 120 秒）。
2. 管线调用 `POST http://127.0.0.1:<port>/v1/chat/completions` 翻译。
3. 连续翻译多个游戏保持服务器运行；切换模型自动重启。
4. 退出程序（FormClosed）时自动停止 llama-server。

## 暂停 / 终止

- 暂停：C# 写 `work\pause.flag`；管线每批翻译前检查，存在则等待（每 500ms 轮询），删除后继续。
- 终止：C# 写 `work\stop.flag`；管线在批次边界保存进度后以 exit 0 优雅退出，已翻译内容保留（断点续翻）。
- 开始新一轮汉化时清理旧 flag。

## UI 变更

- 移除 API 设置栏（模式 / 地址 / 密钥 / 模型 / 保存按钮）与 `api-config.json`。
- 扫描区：盘符下拉 + “扫描” + “选择文件夹”按钮。
- 模型区：下拉列出模型目录 `*.gguf` + “刷新模型” + “模型目录…”（FolderBrowserDialog，默认 `D:\galtrans`，写入 settings.json）。
- 新增“暂停 / 继续”与“终止”按钮。
- 状态栏显示 llama 状态（未启动 / 启动中 / 就绪 / 当前模型）。

## 管线（game-pipeline.js）变更

- 删除 api / hybrid 模式、`askApi`、API key 逻辑；参数简化为 `gameDir model workDir`。
- 本地请求改为 llama.cpp OpenAI 兼容接口（端口可由参数覆盖，默认 18080）。
- 每批前检查 pause/stop flag；启动时清理旧 flag。
- 保留 v2.1 修复：音频资源名不翻译、提示词禁止英文、英文输出兜底检测、断点续翻。

## 错误处理

- llama 启动失败 / 模型目录为空 / 端口被占：日志明确提示，不开始翻译。
- 端口被其他 llama-server 占用且模型一致：复用；不一致：报错提示。
- 暂停期间按钮状态切换；终止后允许重新开始（断点续翻）。

## 测试

- `node --check`、`csc` 编译、`ruby -c`。
- 端到端：llama-server 启动并加载 `D:\galtrans` 模型、/health 就绪、一次真实 chat completion、暂停/终止 flag 行为、退出停止服务器。

## 交付

- v2.2 提交 Git（含 C# 源码、pipeline、使用说明、部署脚本）并推送 GitHub。
- `D:\GameTranslator` 部署完整副本（不含 .git、work 缓存、api-config）。
