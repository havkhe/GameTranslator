# P38 —— 被打包进 exe 的 MV/MZ 游戏：识别并说明原因

生成时间：2026-10-12
分支：`v3-p1`
改动文件：`ui/MainForm.cs`、`tools/game-state.js`、`pipeline/index.js`、`ui/UiCheck.cs`、`tools/unit-game-state.js`
UiCheck：249 → **253 项**；`unit-game-state`：31 → **35 项**

---

## 一、这个游戏为什么既"识别不出"又"翻不了"

```
J:\game\HGAME\H\更多game\妛墍摿寈晹-SIGNIT-惢昳斉 01.3\
  Game_boxed.exe        1,020.9 MB
  www\save\*.rpgsave    只剩存档（common / config / file1 / file2 / global）
  TrsData.bin 等        MTool 的
  （没有 www\data、没有 js\、没有 package.json）
```

实测（直接扫这个 exe 的字节）：

| 事实 | 证据 |
|---|---|
| 是 **Enigma Virtual Box** 打包的单文件 exe | 文件里偏移 864 处有 `.enigma` 标记（EVB 专用） |
| 里面是 **RPG Maker MV** 游戏 | 99.3% 处是 `www/index.html` 的内容，引用 `js/rpg_core.js`；99.9% 处是 `DataManager` 的数据清单（`$dataSystem → System.json`）；**没有** `rmmz_core.js`（那是 MZ） |
| 真正的游戏文件（`data/`、`js/`、`img/`、`audio/`、`fonts/`）都在**这个 exe 里** | `data/`、`img/`、`audio/`、`fonts/`、`icon/` 等路径字符串都出现在文件最后 1%（约 1,054–1,070 MB 之间） |
| 文件末尾是 EVB 的**表**（4 字节递增的项 + 零填充） | 最后 512 字节：`18 31 1c 31 20 31 …` 之后全是 0 |

结论：**数据在 exe 的虚拟文件系统里**。本工具的输入只有两种：真实的 `www/data/*.json` 目录，或
`Game.rgss2a/rgss3a/rgssad` 归档。它既读不到、也写不回 EVB 容器，所以这个游戏**在当前形态下无法翻译** ——
这不是"引擎不支持"，而是"文件被包起来了"。

## 二、改了什么：不再沉默，而是说清楚

以前这个目录**连列表都进不去**（`IsGameDir` 只认 `Game.exe` / 三个归档名 / `www\data`），
所以你看不到它、也得不到任何解释。现在：

1. **扫描认得它**（`ui/MainForm.cs`）：`www\save\` 里有 `*.rpgsave` 且没有 `www\data` →
   这是"应用被打包进可执行文件"的形状（`.rpgsave` 只有 MV/MZ 会写），**收进列表**。
2. **引擎列写明**：`MV（已打包，需先解包）`（悬停提示里也是这句）。
3. **状态列说明原因**（`tools/game-state.js`，新状态）：
   ```
   未汉化（已打包）
   MV/MZ 数据被打包进 Game_boxed.exe（1021 MB，虚拟文件系统），本工具读不到里面的 www\data，
   需先用解包工具把它还原成普通文件夹才能翻译
   ```
   以前这里会显示 `非 MV/MZ` —— 那读起来像"引擎不对"，会把人引到错方向。
4. **管线把话说全**（`pipeline/index.js`）：真的去跑它时，日志是
   ```
   NOT_SUPPORTED 这是一个被打包过的 MV/MZ 游戏：数据（www/data）在 Game_boxed.exe（1021 MB）的虚拟文件系统里，
   本工具读不到。先用解包工具把它还原成普通文件夹（解包后应能看到 www/data/*.json），再来翻译。游戏没有被改动。
   ```
   并且**在任何写入之前就退出**，游戏一个字节都不会变。

## 三、要翻它，需要你做一步：先解包

Enigma Virtual Box 是"把整个应用目录虚拟地塞进一个 exe"的打包器。解法是**解包**：

1. 用 **Enigma Virtual Box 自己的工具**打开这个 exe，或使用第三方的 EVB 解包器（如 EVBUnpack），
   把里面的文件释放出来；
2. 解包完成后，目录里应该能看到 `www\data\*.json`（这才是本工具能读的东西）；
3. 回到本工具 → 重新扫描 → 它会显示成普通的 `MV`，正常翻译即可。

> 我**没有**内置 EVB 解包：那是逆向工程该容器格式（文件表、可选的压缩与校验），并且翻译完还要能写回去，
> 不是小改动。如果你希望我做，我可以先单独评估"读出来 + 写回去"这条路的可行性再动手 —— 但那应该是一次
> 专门的、你点头之后的工作。

## 四、验证

- `unit-game-state.js` **31 → 35 项**：只有 `www\save\*.rpgsave` + 一个大 exe 的目录 → `未汉化（已打包）`，
  备注点名那个 exe、并写明需要解包；普通空目录仍是 `非 MV/MZ`。
- `UiCheck` **249 → 253 项**：`只有 www\save\*.rpgsave + 一个 exe 也算游戏（打包过的 MV/MZ）`、
  `引擎列写明「已打包，需先解包」`、`有 data 目录的游戏按正常 MV/MZ 判定`。
- 用**部署里的**工具与管线各实跑一次：状态输出 `未汉化（已打包）` 与上面那句备注；
  管线输出上面那条 `NOT_SUPPORTED` 并退出（游戏未改动）。

## 五、部署

`GameTranslatorV3.exe.new` 已暂存；`tools/` 与 `pipeline/` 已同步到部署目录。
**关掉程序 → 双击 `应用新版本.bat`**，再「重新扫描全部」，这个游戏就会以
`MV（已打包，需先解包）` / `未汉化（已打包）` 出现在列表里。
