# P11 —— MTool 本体解剖：它的翻译规则，以及为什么 TrsData.bin 不必解

对象：`C:\Users\Administrator\Desktop\MTool`（MTool 本体）、`J:\game\**`（游戏目录里的 MTool 产物）、
仓库新增 `tools/import-mtool.js`。承接 `docs/P10-文本文件与覆盖统计.md`。

---

## 一、MTool 是什么：运行时注入 + 可选内嵌

`Tool\loaders\` 里是各引擎的 Hook DLL：

```
mzHook.dll / mzHook32.dll      RPG Maker MV / MZ
RGSSHook.dll / RGSSHook64.dll  RPG Maker XP / VX / VX Ace
wolfHook.dll / wolfHook3.dll   WOLF RPG
krkr2Hook / krkrzHook32/64     KiriKiri
GodotHook*  PythonHook*  SRPGHook  AgtkHook  BakinLauncher  0Harmony.dll(.NET/Unity)
inject.exe (141MB, 带 nw.js 运行时)
```

游戏目录里它生成的 `与工具一同启动.bat` 把机制写得明明白白：

```bat
inject.exe "%~dp0\Game.exe" "...\MTool\Tool\loaders\mzHook.dll"
start "" "...\MTool\Tool\MTool.exe" "...\MTool\Tool"
```

**即：MTool 把 Hook DLL 注入游戏进程，在运行时拦截文本绘制并替换，默认不修改游戏数据文件。**
（`从游戏中移除工具文件.bat` 删的正是 `winmm.dll` / `version.dll` / `injectPath` /
`LocaleEmulator.dll` / `lastLoadedTrsFile` 这些注入物。）

它另有一个**内嵌汉化**模式，产物就是游戏目录里的：

```
data_原版备份\     ← 汉化前的数据副本
data_汉化备份\     ← 汉化后的数据副本
一键还原汉化前.bat  ← 用 原版备份 覆盖 Data/ 或 www\data
一键恢复汉化.bat    ← 用 汉化备份 覆盖
```

> **对本项目很重要**：`data_原版备份` / `data_汉化备份` 这对目录名**原本是 MTool 的约定**。
> 本管线把它读作"纯净日文原文"，在这些游戏里恰好成立（备份确实是汉化前的数据），
> 所以两者可以共存；但要知道来源不是本管线。

---

## 二、TrsData.bin：加密没问题，因为同一份数据有明文形态

实测 `TrsData.bin`（1.1MB ~ 10MB，库内 83 个游戏有）：

- 字节直方图接近均匀（ASCII 可打印 37.1%，与 95/256 一致），无 gzip / zlib / brotli 头
  → **混淆或强压缩，非明文**，直接解不划算也不必要。

关键是 MTool **自己**就提供明文形态，并且会记录当前在用哪一份：

```
游戏目录\lastLoadedTrsFile   →  内容就是 "A翻译.json"      （MTool 记录正在加载的译文文件）
游戏目录\A翻译.json           →  { "看守イベント制御テスト": "看守事件控制测试", ... }  28,917 条
游戏目录\ManualTransFile.json →  { "看守イベント制御テスト": "看守イベント制御テスト", ... } 32,783 条（待译模板）
```

- `ManualTransFile.json` = 给外部翻译器（AiNiee 等）用的**导出**：键是原文，值是占位。
- `A翻译.json` / `AI翻译文件.json` = **加载**进来的译文文件：原文 → 中文。
- `TrsData.bin` 只是这套数据的内部二进制存储；`TrsData_Bing_*.bin` /
  `TrsData_Google_*.bin` 是按翻译渠道 + 时间戳的历史副本（库内 94 个）。

**结论：不需要解 TrsData.bin。** 凡是翻译者留了 JSON 的游戏，译文本来就是明文可读的。

---

## 三、MTool 的"需要翻译的文件/字段"清单（实测，不是猜）

拿唯一同时有明文导出与译文的游戏 `PrisonBrave_1.1.0`，把 `ManualTransFile.json` 的
**32,783 个键**逐个对回游戏文件，得到它真正的目标位置：

| 条数 | 位置 | 本项目 |
| --- | --- | --- |
| 9,183 | 事件指令 **code 657 参数**（`エフェクト種別 = suction` 这类插件指令参数行） | ✗ 未覆盖 |
| 8,468 | 游戏里找不到（`"338"`、`"333"` 这类**纯数字 id**） | 本就该排除 |
| 8,256 | 事件指令对象上的 **`.comment` 字段** | ✗ 未覆盖 |
| 2,671 | `.name` 字段 | ✓ |
| 1,524 | 事件 **code 108**（注释命令）参数 | ✗ 未覆盖（我们有意不翻） |
| 1,160 | `js/plugins.js` 插件参数值 / 插件源码 | ✗ 未覆盖 |
| 444 | 事件指令对象上的 `.text` 字段 | ✗ 未覆盖 |
| 253 | `.description` | ✓ |
| 142 | 音频容器里的 `.name`（`Heal3`） | ✓ 有意不翻（资源名） |
| 121 | `.effectName`（`Animations.json`） | ✗ 未覆盖 |
| 121 | 事件 code 402 选择支 | ✓ |
| 95 | 事件 code 401 对话 | ✓ |
| … | `.note`(49)、code 408 注释续行(56)、code 357 插件指令(81)、`.presetName`/`.altName`/`.playLog`/`.windowName`、`.align`/`.part`/`.type`（配置值） | 大多 ✗ |

另外从本体反出的**VX Ace 规则**（`loader.bin.ff` 内嵌的可读 Ruby 源码）：

```ruby
varSpilt = "…"; lineSpilt = "…"
dataUseNow = $data_items
dataUseNow.each_index{|i|
  out << i.to_s << varSpilt << name << varSpilt << description << lineSpilt
  # note 内可能含有分隔符，必须做清理，否则 JS 端 split 会被破坏
}
```

即：**数据库每条记录的 `name ∨ description [∨ note]` 全导出**，外加 `goldName/hpName/mpName/tpName`、
菜单禁用标志等系统串；键与值用可配置分隔符拼接（这也是它必须把 `note` 里的分隔符洗掉的原因）。

### 与本项目规则的差别（结论）

MTool 的规则是"**数据树里几乎所有字符串 + 插件参数 + 插件源码**"，只在很窄的范围内排除。
实测它的键里混进了：

- 纯数字 id（`338`，8,468 条）、配置值（`right` / `body` / `out`）、
- **资源名**：`Heal3`（音效）、`!Door1` / `Stoneknight`（图片）、`Animations[59].soundTimings[0].se.name`

→ **这正是本项目这轮修掉的那类损坏的根源**：MTool 会去翻音频/图片的文件名字段，
本管线曾经也会（`bgm.name` 44 处、`sounds[].name` 5 处）。所以它的键表**不能直接当"必须翻译"的
判据**，只能当"可能有文本"的线索。

---

## 四、可复用的部分：把 MTool 的译文导进本项目的缓存

新增 `tools/import-mtool.js`：

```
node tools/import-mtool.js <gameDir> [--file <name.json>] [--work <dir>] [--apply] [--top N]
```

- 自动在游戏根目录找形如"扁平 JSON、≥200 键、键为日文"的对照表；
- 每一条都过**本项目的判据**：源串必须过 `isTranslatable()`（id/数字/文件名/资源名自动排除）、
  源串含假名、译文是中文且不含假名；
- 再经**缓存自身的门禁**：指令回显 / 退化 / **控制代码不符**一律拒收（与模型产出同一条路径）；
- 写入前把原缓存备份为 `*.bak-import`，可回退；`--apply` 才写。

### 实测（已执行）

| 游戏 | 对照表 | 明文可读 | 采用 | 缓存总量 |
| --- | --- | --- | --- | --- |
| `PrisonBrave_1.1.0` | `A翻译.json` 28,917 键 | 28,692 中文值 | **27,296** | 27,296 |
| `借金JK人生NTRゲーム` | `AI翻译文件.json` 12,940 键 | 12,781 中文值 | **12,425**（46 已有，1 被拒收） | 12,489 |

**导入口的收益（只读核对，未改游戏数据）**：

```
PrisonBrave_1.1.0        提取器找到可译条目 12,714 条，缓存已有 10,175 条  →  80%
借金JK人生NTRゲーム       提取器找到可译条目 10,205 条，缓存已有  7,980 条  →  78%
```

剩下的 20~22% 仍需模型翻（例如 `\N[002]くん…` 这类带变量代码的对话行）。
要真正写进游戏，只需按平常方式跑一次管线：待译条目为 0 或很少，**不会产生模型请求**，
补丁阶段会把缓存里的译文写进 `data`（首次运行会自动建 `data_原版备份`）。

---

## 五、怎么在游戏目录里认出这些线索

| 文件 / 目录 | 含义 | 可读性 |
| --- | --- | --- |
| `TrsData.bin` | MTool 内部译文库 | 混淆，不必解 |
| `TrsData_Bing_* / _Google_*.bin` | 按渠道+时间戳的历史副本 | 同上 |
| `ManualTransFile.json` | 待译导出（键=原文） | **明文** |
| `A翻译.json` / `AI翻译文件.json` | 已加载的译文表（原文→中文） | **明文，可直接复用** |
| `lastLoadedTrsFile` | 当前在用的译文文件名 | 明文 |
| `MTool_MapDataCache/` | MTool 自己解析过的数据副本（19 个游戏有） | 明文 |
| `MTool_TilesetDefinedCache.json` | 它缓存的 Tilesets 数据（8 个） | 明文 |
| `Dictionaries/*.bdic` | 词典（ECDICT 类），术语一致性用 | 二进制词典格式 |
| `data_原版备份` / `data_汉化备份` + 两个还原 bat | **内嵌汉化**模式的产物 | — |
| `与工具一同启动.bat` / `从游戏中移除工具文件.bat` | 注入模式的启动器与卸载器 | 明文 |

---

## 六、自检

```
node tools/unit-import-mtool.js   pass 20  fail 0
node tools/unit-text2frame.js     pass 30  fail 0
node tools/unit-prompt-echo.js    pass 35  fail 0
node tools/unit-degeneration.js   pass 47  fail 0
node tools/unit-parse-result.js   pass  9  fail 0
node D:\dsh\gt-audit\check-deploy.js   仓库与部署 0 差异
```
