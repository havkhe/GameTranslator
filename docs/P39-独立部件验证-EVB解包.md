# P39 —— 独立部件验证：从 Enigma Virtual Box 里解包（**未通过验证，未并入**）

生成时间：2026-10-12
分支：`v3-p1`
结论：**没有完成验证 → 按你的规则不并入翻译器**。本文记录做到了哪一步、卡在哪、以及接下来可行的两条路。
探测脚本（可复现）：`D:\dsh\gt-audit\p33\` 下的
`boxed-probe*.js`（容器内布局）、`evb-anchor.js`（PE 节表 + `EVB\0` 头）、`enigma-head.txt`、`ebv-*.txt`

---

## 一、已经确定的事实（可直接复用）

| 项 | 值 |
|---|---|
| 打包器 | **Enigma Virtual Box**（文件内偏移 864 处有 `.enigma` 标记） |
| 引擎 | **RPG Maker MV**（99.3% 处是 `www/index.html` 的内容，其 `<title>` 就是 `学園特警部-SIGNIT-DLsite製品版01.3`；无 `rmmz_core.js`） |
| 文件存放方式 | **逐个原样拼接、不压缩**（PNG 以 `IEND\xae\x42\x60\x82` 结束，紧接着就是 `<!DOCTYPE html>` 的 `index.html`） |
| 包体位置 | PE 节 `.enigma1`：raw 起点 `0x187a00`（1,604,096），`SizeOfRawData = 1,068,576,768`（几乎整个文件）；另有 `.enigma2`（raw `0x3fc9aa00`，274,432 字节） |
| 包头 | **`EVB\0` 在节内偏移 `0xA0`**（绝对 1,604,256）；其后 4 字节 `40 00 00 00`（=64），与 `EVB_PACK_HEADER = "4s 签名 + 60s"`（64 字节）吻合 |
| 树的起点 | 包头之后 = **绝对 1,604,320**；该处首 4 字节 `25 33 03 00`（LE 209,701，像"整棵树的大小"），`+12` 处 `01 00 00 00`（`objects_count = 1`，只有一个顶层子节点） |
| 数据在哪 | 全部在文件末尾 ~1%（1,054–1,070 MB），与 `data/`、`js/`、`img/`、`audio/`、`fonts/` 的路径字符串位置吻合 |
| 文件末尾 | 最后 ~3.4 KB 是一张 4 字节递增的表（`0x3118, 0x311c, … 0x335c`）后接零填充 |

参考实现（公开）：

- **evbunpack**（Python，Apache-2.0）——支持 EVB 7.80/9.70/10.70，有 `--legacy-fs`
- **evb-extractor**（Python，MIT，Roman Bondarenko）——`evbe.py` + `EVBE/EVBFile.py`、`EVBE/EVBContainer.py`、`EVBE/EVBFileSystem.py`、`aplib.py`
- **XStaticUnpacker / XEnigmaVB**（C++）——其中 `EVB_PACK_HEADER`、`EVB_HEADER_NODE(I size, 8s, I objects_count)`、`EVB_NODE_NAMED(名字, B type)`、`EVB_NODE_OPTIONAL_FILE(2s, I original_size, 4s, 8s×3 filetime, 15s, I stored_size)`、节点类型 `0=MAIN / 2=FILE / 3=FOLDER` 就是本次照抄的结构来源。

## 二、为什么没通过验证

我按上面的结构写了探测解析器，但**两个参考实现给出的记录布局彼此不一致**，而这个包**两个都对不上**：

1. 名字字段位置对不上：按参考实现，命名节点在 `节点+16` 处是 UTF-16LE、以 2 字节 0 结尾的名字；
   实际在树起点之后的第一个子节点处（1,604,336）读到的是 `00 00 00 01 …`，**解不出名字**。
   → 说明这个版本的节点头不是 16 字节、或名字不在 `+16`。
2. 可选块（`stored_size` 等）两家的字段顺序不同：
   evb-extractor 的 `OPTIONAL` = `H I I Q Q Q B H I [stored_size] I`（49 字节 = 0x31）；
   evbunpack 的 `EVB_NODE_OPTIONAL_FILE` = `2s I 4s 8s 8s 8s 15s I`（53 字节），
   并且 PE 文件还多一个 `4s` + `7s` 填充。
   `stored_size` 在节点内的偏移因此差 4 字节以上 —— 猜错就是整棵树错位、名字变乱码。
3. **最关键的一条（决定性的）**：我拿"已知答案"去反推过布局 —— `index.html` 的内容起点是**确定已知**的
   绝对偏移 `1,063,146,347`（那个 `<!DOCTYPE html>` 就是）。树里必须有指向它的记录，所以我全文件搜了这个值
   以及它的各种可能表示（相对 `.enigma1` 节首、相对树起点、相对数据区 `节首+0x98`，还有页对齐后的变体）：
   **每一种表示全文件只命中 1 处，而且命中点前后都是高熵字节**（`68 84 4d 90 0c cc 91 88 …`），
   完全不是目录结构的样子。也就是说：**目录表（文件名与偏移）被加密/混淆了**，
   这正是 evbunpack 需要"恢复 TLS / 异常表 / 重定位并解密目录"的原因。
   → 光靠试错拿不到布局，必须先复现 EVB 的加密/混淆算法。
4. 版本信息也指向"版本不同"：`.enigma1` 的 `VirtualSize` 只有 4096 而 `SizeOfRawData` 是 1 GB；
   另外还有一个 `CPADinfo` 节（40 字节）—— 这些都不是参考实现注释里描述的那个版本的样子。

另外两条现实约束：

- 这台机器**没有可用的 Python**（只有 `WindowsApps\python.exe` 这个 Microsoft Store 占位程序，
  直接运行不会得到解释器），所以"直接调用现成的 evbunpack/evb-extractor"这条路现在走不了；
- 整个游戏库里**只有这一份**（没有未打包的副本）。

**而且**：即使只把"读"做对，翻译还要求**写回**——把改过的 `www/data/*.json` 塞回容器（要在长度变化时
同步改树里的 `stored_size`）。写回依赖同一套布局知识，风险更大。所以我**没有**把半成品并入翻译器：
按你说的"能够完成验证则加入"，它现在**没有通过验证**。

## 三、接下来可行的两条路（你选）

**A. 装一次 Python，用成熟工具解包（推荐，成本最低、确定性最高）**

```bat
pip install evbunpack
evbunpack "J:\game\...\妛墍摿寈晹-SIGNIT-惢昳斉 01.3\Game_boxed.exe" -o "D:\SIGNIT_unboxed"
:: 若报版本不符，再试：  evbunpack --pe 10_70 ...  /  --pe 9_70 ...  /  --pe 7_80 --legacy-fs ...
```
解包成功后目录里会出现 `www\data\*.json` → 回到本工具扫描一次，它会显示成普通 `MV`，正常翻译。
（也可以配合 UniExtract2，它内置了 EVB 支持。）

**B. 让我继续把容器格式啃下来（作为独立部件，不通过验证就不并入）**

起点已经查清并记在上面，但**上面第 3 条说明这条路不只是"多试几轮"**：目录表被加密，
必须复现 EVB 的目录加密/混淆算法（各家版本不同，公开实现的按键处理也不同），
再验证"读出来 → 改掉 → 写回去 → 游戏还能读"整条链。
这已经不是"小改动"，而是一次有明确不确定性的逆向工程。你说继续，我就按这个方向专门做一轮；
在那之前不会往翻译器里加任何东西。

**（我的建议：先走 A。** 装一次 Python 是最省事、最确定的；B 适合在你不想装 Python 时才作为备选。**）**

## 四、当前已经生效的部分（上一轮，已提交）

游戏现在**会出现在列表里**，并被明确标注：
引擎列 `MV（已打包，需先解包）`，状态列 `未汉化（已打包）`，备注写下是哪个 exe、多大、为什么要先解包；
直接对它跑翻译，管线会在**任何写入之前**退出并打印
`NOT_SUPPORTED 这是一个被打包过的 MV/MZ 游戏：数据（www/data）在 Game_boxed.exe（1021 MB）的虚拟文件系统里…`。
（见 `docs/P38-打包进exe的游戏.md`，提交 `458eb237`。）
