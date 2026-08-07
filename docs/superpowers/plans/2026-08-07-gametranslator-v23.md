# GameTranslator v2.3 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 发布 v2.3.0（预览版，v2.2.6 保持正式版不动）：CUDA 用户可自行调节 llama 各项参数、翻译提示词可配置（默认预填默认提示词）、GUI 布局重构（菜单栏 + 双行工具栏 + 右侧可折叠设置面板）。

**Architecture:** C# WinForms 单文件（GameTranslator.cs）扩展 Settings 数据模型；新增 SettingsForm 对话框（Tab 1 llama 参数 / Tab 2 翻译提示词）；game-pipeline.js 通过 argv[7] 读取提示词文件，支持 `{lines}` 占位符；构建产物打包为 Vulkan 通用版与 CUDA12 RTX 版两个 zip。

**Tech Stack:** C# (.NET Framework WinForms, csc.exe)、Node.js、llama.cpp（Vulkan / CUDA 12.4）、PowerShell（打包/上传）、GitHub Releases API。

---

## 文件结构

- 修改：`GameTranslator.cs`（Settings 扩展、BuildLlamaArgs、SettingsForm、BuildUi 重构、菜单、提示词文件传递）
- 修改：`game-pipeline.js`（DEFAULT_PROMPT、prompt 文件读取、buildPrompt、{lines} 占位符）
- 修改：`使用说明.txt`（v2.3 更新说明）
- 新增：`docs/superpowers/plans/2026-08-07-gametranslator-v23.md`（本计划）
- 复用：`D:\GameTranslator\llama`（Vulkan 运行时）、`D:\GameTranslator\llama-cuda-old`（CUDA 运行时）、`D:\GameTranslator\node`、`outputs\GameTranslator\ruby`
- 输出：`D:\GameTranslator-v2.3.0-通用版-Vulkan.zip`、`D:\GameTranslator-v2.3.0-RTX版-CUDA12.zip`

## Task 1: game-pipeline.js 支持自定义提示词

- [ ] 新增 `DEFAULT_PROMPT` 常量（末尾含 `{lines}`），`PROMPT_FILE = process.argv[7]`
- [ ] 新增 `buildPrompt(lines)`：含 `{lines}` 则替换，否则追加在末尾
- [ ] `translate()` 中改用 `buildPrompt(batch)`
- [ ] `node --check game-pipeline.js`

## Task 2: Settings 数据模型扩展

- [ ] `Settings` 增加：LlamaContext(4096)、LlamaGpuLayers(99)、LlamaBatch(512)、LlamaUbatch(256)、LlamaThreads(0)、LlamaFlashAttn("auto")、LlamaCacheK("f16")、LlamaCacheV("f16")、Prompt(DefaultPrompt)
- [ ] 新增 `Settings.DefaultPrompt` 常量（与管线默认一致）
- [ ] 新增 `NormalizeSettings()`：补默认值、范围钳制；`LoadSettings()` 后调用
- [ ] 新增 `BuildLlamaArgs(modelPath)`：按设置生成 `-m ... -c ... -ngl ... -b ... -ub ... [-t ...] [-fa on|off] [-ctk/-ctv ...] --no-webui`

## Task 3: SettingsForm 对话框

- [ ] 新增 `SettingsForm` 类：TabControl 两个 Tab
- [ ] Tab1 llama 参数：上下文、GPU 层数、批大小、物理批大小、CPU 线程、FlashAttention、K/V 缓存类型、端口、内存上限 + 恢复默认
- [ ] Tab2 翻译提示词：多行文本框（默认填入默认提示词）+ 恢复默认提示词 + `{lines}` 说明
- [ ] 保存时钳制数值并回写 settings，调用方重启 llama 使参数生效

## Task 4: BuildUi 布局重构

- [ ] 新增 MenuStrip（文件/翻译/设置/帮助），全部既有动作接入菜单
- [ ] 顶部双行工具栏：第一行扫描区，第二行模型 + 汉化动作
- [ ] 中部垂直 SplitContainer：左列表，右侧可折叠设置面板（设备、llama 启停、llama 设置、提示词设置、检查/卸载/恢复）
- [ ] 底部保持日志 + 进度条 + 状态栏；版本号改 v2.3

## Task 5: 提示词文件传递

- [ ] `TranslateGame` 写 `work\prompt.txt`（UTF-8），argv 追加 `translate <promptFile>`
- [ ] check 模式参数保持兼容

## Task 6: 文档与部署脚本

- [ ] `使用说明.txt` 增加 v2.3 更新说明
- [ ] `deploy-to-d.ps1` 默认 settings.json 保持不变（NormalizeSettings 兜底）

## Task 7: 构建与静态校验

- [ ] csc 编译 `GameTranslator.exe`（/codepage:65001 + System.Windows.Forms/Drawing/Management/Runtime.Serialization/Xml/Core）
- [ ] `node --check game-pipeline.js`、`ruby -c vxace_*.rb`

## Task 8: 打包与部署

- [ ] 暂存目录 `D:\gt-build-v23\GameTranslator`（Vulkan）与 `D:\gt-build-v23\GameTranslator-CUDA`（CUDA），复制 app 文件、node、ruby、对应 llama 运行时、默认 settings.json
- [ ] .NET ZipFile 压缩为两个 zip 到 D 盘
- [ ] 复制新 exe / pipeline / 使用说明到 `D:\GameTranslator`（保留用户 settings.json 与 llama 运行时）

## Task 9: 发布与 Git

- [ ] Git 提交 v2.3.0 源码、打 tag、push origin main --tags
- [ ] GitHub API 创建 release v2.3.0（prerelease=true，v2.2.6 保持正式版），上传两个 zip，写中英文发布说明
