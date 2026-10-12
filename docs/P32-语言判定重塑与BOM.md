# P32 —— 语言判定重塑：英文原版不再被判成「自带中文」（外加 System.json 的 BOM 修复）

生成时间：2026-10-12
分支：`v3-p1`
改动文件：`tools/game-state.js`、`tools/unit-game-state.js`（新）、`pipeline/extract/mv.js`、`pipeline/extract/resources.js`、`pipeline/patch/mv.js`、`tools/unit-event-codes.js`
单测：新增 `unit-game-state.js` **24 项**；`unit-event-codes.js` 14 → **21 项**；全库 17 套全绿

---

## 一、现象与实测

`J:\game\HGAME\H\Detective Girl of the Steam City (eng-uncen) + save\…` 在界面里显示**已汉化**（实际状态名是
`自带中文`），因此被跳过、永远不会去翻。实测它到底翻没翻：

| 测量 | 数值 |
|---|---|
| live `www/data` 的 401 对白行 | **13,960 行，13,900 行英文、0 行中文** |
| `data_原版备份` 的同批对白 | 完全相同（也是 13,900 行英文） |
| live 全目录字母数 | 拉丁 6,413,460 / 汉字 16,226 / 假名 2,494 |
| 该游戏的翻译缓存 | 4,724 条，**全部是"日文→中文"**（键如 `打撃/物理`），**没有一条英文** |

结论：**这局确实没翻**（玩家看到的是英文），而我们的补丁历史上只写过 1,737 处（`Actors/Skills/States/System`
这类名词/词条），对白一条没动。所以"显示已汉化但游戏里没汉化"成立。

## 二、为什么会被判成「自带中文」

`tools/game-state.js` 的判据是"**假名占 CJK 字符的比例**"（`byteProfile` 只数假名和汉字，**完全不计拉丁字母**）：

```
backup 假名 6,605 / 汉字 13,531  →  32.8%
CN_MAX = 35   →  32.8 < 35  →  "原版数据即中文"  →  自带中文
```

对中文/日文游戏，这个比例是有意义的（非 ASCII 文本几乎全是 CJK）。但对**英文游戏**，它是"极小少数内部的比例"：
6,605 个假名对上 **641 万个拉丁字母**，13,531 个汉字里混进几个假名就能把它推到 30% 上下——**这个数字根本不代表语言**。
判据从来没有问过一句"这游戏是不是拉丁文字"。

> 关于你猜的 "mtool 被检测"：MTool 的文件（`TrsData.bin` 2.2 MB、`data_汉化备份`、
> `一键恢复汉化.bat` / `一键还原汉化前.bat`）确实都在，但它们在旧代码里只影响**备注文字**
> （"含汉化组的还原脚本"）和 `installedByUs` 标记，**不是** `自带中文` 的来源——来源就是上面那个 32.8%。

## 三、重塑后的判定（`tools/game-state.js`）

1. `byteProfile` **新增统计拉丁字母**，并给出两个比例：
   - `kanaPct`：假名 / (假名+汉字) —— 含义不变，仍用于 CJK 游戏；
   - `latinPct`：拉丁 / 全部字母 —— **新增，用来回答"这到底是不是 CJK 文本"**。
2. 新增 `isLatinText(p)`：`latinPct ≥ 70%` 且字母总量 ≥ `CJK_MIN` 时，这堆数据就是**拉丁文字游戏**。
3. 新增状态 **`未汉化（英文原版）`**：
   - 字节路径（VX/VX Ace、归档）与 JSON 路径都各有一处判定，位置在**中文 locale 检查之后、所有依赖 CJK 比例的判定之前**；
   - 于是任何比例都不可能把英文游戏说成中文；
   - 状态名以「未汉化」开头，界面的 `Skip = 已是中文/自带中文` 逻辑天然不再跳过它 —— 这正是要的结果。
4. **所有依赖 CJK 比例的分支都加了闸门**：
   - `自带中文`（原版即中文）额外要求**原版不是拉丁文字**——否则一个英文原版、live 已译成中文的游戏，
     仍会被"原版的 32.8%"判成自带中文；
   - `已是中文`（外置汉化）额外要求 live 不是拉丁文字；
   - 比例本身要求 `CJK 字符数 ≥ CJK_MIN = 200`：22 个字符算出来的比例是噪声，不足以定语言。
5. `verdictFromBytes`/`classify` 的"无文本"判据从 `total < 20` 改成 `letters < 20`，并让 `isLatinText` 兜住
   ——一个 640 万字母的游戏绝不能被说成"可译文本太少"。
6. 为可测试性导出内部函数（`classify/byteProfile/isLatinText/verdictFromBytes/locate/findBackup/CN_MAX/JP_MIN/LATIN_TEXT_PCT/CJK_MIN`），
   并把 CLI 收进 `require.main === module` —— `require` 它不再会去扫 `J:\game`。

### 现在这局的判定

```
未汉化（英文原版）  原版是英文（拉丁字母 99.7%，6413460 个；假名占比只是 CJK 内部比例），本工具曾处理过
```

## 四、顺带修掉：`System.json` 因为 BOM 被整个跳过

同一局的补丁报告里有一条一直没人发现的错误：

```json
{"file":"System.json","err":"parse: Unexpected token '\uFEFF', \"{\"airship\"... is not valid JSON"}
```

RPG Maker MV 给部分数据文件写了 **UTF-8 BOM**，而 `JSON.parse` 拒绝它。`pipeline/` 里**没有任何一处**剥 BOM（查过全部 5 个从游戏目录读 JSON 的位置），
所有位置都是 `catch (e) { continue; }` —— 于是 `System.json`（`terms` 整块：菜单词、保存/读档提示、技能类型与属性名）
**既没被抽取也没被回填**，报告只写"244 条 missing"，不说是为什么。

改法：`pipeline/extract/mv.js` 新增并导出 `readJsonFile(full)`（剥掉开头的 `\uFEFF` 再 parse），
`pipeline/patch/mv.js` 与 `pipeline/extract/resources.js` 一律走它；**回写时若原文件有 BOM 就补回去**，
不改动游戏自己加载器习惯的编码。

## 五、验证

- `tools/unit-game-state.js`（**24 项**）：英文原版 → `未汉化（英文原版）`；英文原版 + 英文的原版备份 → 仍不是自带中文；
  中文原版（汉化组发行）→ 仍是 `自带中文`；中文数据但无备份 → `已是中文`；日文原版 → `未汉化`；
  用 **Detective Girl 的实测字节数**做回归（旧判据确实算出 32.8%，现在判成英文原版）；
  以及 `isLatinText` 的 70% / `CJK_MIN` 边界。
- `tools/unit-event-codes.js`（**21 项**）：新增"带 BOM 的 System.json"一组——4 个词条照常抽出、照常替换、
  无解析错误、回写后 BOM 仍在、其它字段原样。
- 其余 15 套全绿。
- 部署目录已同步（`pipeline/` 3 个文件 + `tools/*.js` 25 个文件），在部署里跑 `node tools\game-state.js`
  对该游戏已输出 `未汉化（英文原版）`。**状态由 `tools/` 决定，不需要换 exe**（界面只是调用它）。

## 六、还没解释清楚的（如实记录）

这局的**历史行为**与缓存对不上，我没有把它当成已解释：

- 缓存里 4,724 条全是"日文→中文"，可这局的抽取值里日文词条只有约 1,100 条 —— 说明缓存里有一部分不是本局跑出来的
  （可能是 `TrsData.bin` 经 `import-mtool.js` 导入的、针对**日文原版**的 MTool 译文库）；
- `work\` 里那份 9,946 条的 extract（13:37）与 1,052 条的 translate-report（14:28 之前）不是同一次运行，
  而 13:37 那次**没有留下 report**（被中断），所以对白为什么一条都没进缓存，缺少决定性证据。
- 可以确定的是：**现在重新抽一次会得到 9,946 条、含 10,358 行对白**（在临时目录里实跑过，未碰游戏），
  而英语源早在 P26 就已被 `isTranslatable`/`translatableSource` 接受 —— 所以状态修好之后，
  这局重新开始翻译就会真的把对白送去翻。**建议先在小范围验证再全量重跑。**
