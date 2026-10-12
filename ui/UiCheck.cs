// Structural verification of the single-page UI.
//
// Instantiates MainForm, walks its control tree and asserts the things the user asked
// for: a model selector, a detailed progress panel, no tabs, and the expected buttons.
// This is stronger than a screenshot for layout questions — it names what is present.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;

namespace GameTranslatorV3.UiCheck
{
    internal static class Check
    {
        private static int _pass, _fail;

        private static void Assert(bool ok, string what)
        {
            Console.WriteLine((ok ? "  PASS  " : "  FAIL  ") + what);
            if (ok) _pass++; else _fail++;
        }

        [STAThread]
        private static int Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            var root = AppDomain.CurrentDomain.BaseDirectory;
            Form form = null;
            try
            {
                form = new MainForm(root);
            }
            catch (Exception ex)
            {
                Console.WriteLine("  FAIL  构造 MainForm 抛异常: " + ex.Message);
                Console.WriteLine(ex.StackTrace);
                return 1;
            }

            var all = Flatten(form).ToList();
            Console.WriteLine("控件总数: " + all.Count);
            Console.WriteLine("");

            Console.WriteLine("=== 单页要求（不得有选项卡）===");
            Assert(!all.OfType<TabControl>().Any(), "没有 TabControl（功能集成在同一页面）");

            Console.WriteLine("");
            Console.WriteLine("=== 模型选择 ===");
            var combos = all.OfType<ComboBox>().ToList();
            Assert(combos.Count >= 1, "存在模型下拉框 (ComboBox) 数量=" + combos.Count);
            // The model selector is picked by name, not by position: the queue panel added a second
            // ComboBox (the target group), and taking the first one in the tree would silently test the
            // wrong control.
            var modelCombo = combos.FirstOrDefault(c => c.Name == "cmbModel") ?? combos.FirstOrDefault();
            Assert(modelCombo != null && modelCombo.Name == "cmbModel", "模型下拉框按名字定位（cmbModel）");
            Assert(modelCombo != null && modelCombo.Items.Count > 0,
                "模型下拉框已填充：" + (modelCombo == null ? "无" : modelCombo.Items.Count + " 项"));
            if (modelCombo != null && modelCombo.Items.Count > 0)
            {
                var names = modelCombo.Items.Cast<object>().Select(x => Convert.ToString(x)).ToList();
                Console.WriteLine("        模型: " + string.Join(", ", names.Take(6)) + (names.Count > 6 ? " …" : ""));
                Assert(!names.Any(n => n.StartsWith("mmproj", StringComparison.OrdinalIgnoreCase)),
                    "视觉投影文件 (mmproj) 未混入模型列表");
            }

            Console.WriteLine("");
            Console.WriteLine("=== 进度详细状态 ===");
            var bars = all.OfType<ProgressBar>().ToList();
            Assert(bars.Count >= 2, "有两个进度条（批次进度 + 当前游戏进度）数量=" + bars.Count);

            var labels = all.OfType<Label>().Select(l => l.Text ?? "").ToList();
            foreach (var want in new[] { "批次", "当前", "条目", "速度", "用时", "模型", "请求", "失败" })
                Assert(labels.Any(t => t.Contains(want)), "进度面板包含「" + want + "」字样");

            Console.WriteLine("");
            Console.WriteLine("=== 游戏列表（虚拟模式）===");
            // Virtual mode is what keeps start-up at about a second: rows are produced on demand
            // instead of being pushed into the native control, which cost ~300 ms per row.
            //
            // The game list is picked out by VirtualMode rather than by position: the 翻译对照 panel added
            // a second ListView, and taking lists[0] would silently depend on which pane the walk reaches
            // first.
            var lists = all.OfType<ListView>().ToList();
            var gameList = lists.FirstOrDefault(l => l.VirtualMode);
            Assert(gameList != null, "存在游戏列表（VirtualMode=true）数量=" + lists.Count(l => l.VirtualMode));
            Assert(lists.Count(l => l.VirtualMode) == 1, "恰好一个虚拟列表（游戏列表）");
            Assert(lists.Count == 2, "列表控件共 2 个（游戏列表 + 翻译对照）实际=" + lists.Count);
            if (gameList != null)
            {
                var lv = gameList;
                Assert(lv.VirtualMode, "列表处于虚拟模式 (VirtualMode=true)");
                // The check is drawn as a character in the first column, not as the native themed box:
                // at 200 % display scaling the native glyph rendered as nothing on the machine this was
                // built for, so it could be seen but not aimed at.
                Assert(!lv.CheckBoxes, "勾选不再依赖原生复选框（改用首列字符 ☑/☐）");
                Assert(lv.ShowItemToolTips, "列表启用悬停提示（列宽装不下的全文靠它读）");
                Assert(lv.Columns.Count >= 5, "列表列数=" + lv.Columns.Count);
                Console.WriteLine("        列: " + string.Join(" | ", lv.Columns.Cast<ColumnHeader>().Select(c => c.Text)));
                Console.WriteLine("        行数: " + lv.VirtualListSize + "（来自 work\\games-cache.json）");
                Assert(lv.VirtualListSize >= 0, "行数已发布：" + lv.VirtualListSize);
                // The columns must fit inside the list, or the last one is the text that gets cut —
                // which is exactly what 「未汉化（已还原）（有原…」 was.
                int total = lv.Columns.Cast<ColumnHeader>().Sum(c => c.Width);
                Assert(total <= lv.ClientSize.Width, "列宽合计 " + total + " ≤ 列表宽度 " + lv.ClientSize.Width);
                if (lv.VirtualListSize > 0)
                {
                    // Asking for a row must produce one without throwing — that is the contract the
                    // control relies on while the user scrolls.
                    var it = lv.Items[0];
                    Assert(it != null && it.SubItems.Count >= 5, "第 1 行可取且列数正确");
                    if (it != null)
                    {
                        Console.WriteLine("        第 1 行: " + it.SubItems[1].Text + "  [" + it.SubItems[4].Text + "]");
                        Assert(it.ToolTipText != null && it.ToolTipText.Length > 0, "第 1 行带悬停全文");
                        Assert(it.SubItems[0].Text == "☑" || it.SubItems[0].Text == "☐",
                            "首列是勾选字符：" + it.SubItems[0].Text);
                    }
                }
            }

            Console.WriteLine("");
            Console.WriteLine("=== 功能按钮 ===");
            var buttons = all.OfType<Button>().Select(b => b.Text ?? "").ToList();
            Console.WriteLine("        按钮: " + string.Join(" | ", buttons));
            foreach (var want in new[] { "开始汉化选中", "全部汉化", "暂停", "继续", "终止",
                                         "检查翻译", "卸载汉化", "恢复汉化", "启动模型", "停止模型", "设置…",
                                         "扫描文件夹", "扫描全部路径", "重新扫描全部", "添加游戏", "刷新状态" })
                Assert(buttons.Any(t => t.Contains(want)), "按钮存在：" + want);

            Console.WriteLine("");
            Console.WriteLine("=== 互斥状态（未运行时）===");
            var byText = all.OfType<Button>().ToDictionary(b => b.Text ?? "", b => b);
            Assert(byText.ContainsKey("终止") && !byText["终止"].Enabled, "未运行时「终止」为禁用");
            Assert(byText.ContainsKey("暂停") && !byText["暂停"].Enabled, "未运行时「暂停」为禁用");
            Assert(byText.ContainsKey("继续") && !byText["继续"].Enabled, "未运行时「继续」为禁用");
            Assert(byText["开始汉化选中"].Enabled == false, "未勾选游戏时「开始汉化选中」为禁用");
            Assert(byText.ContainsKey("全部汉化") && byText["全部汉化"].Enabled, "有游戏时「全部汉化」为可用");

            Console.WriteLine("");
            Console.WriteLine("=== 勾选交互（不依赖原生复选框）===");
            if (gameList != null)
            {
                var lv = gameList;
                // Toggling must change the model and be reflected in the count line — the two things the
                // row click does. Exercised through the same private method the click handlers call, so
                // this covers the action itself even though a click cannot be synthesised here.
                var toggle = typeof(MainForm).GetMethod("ToggleRow", BindingFlags.NonPublic | BindingFlags.Instance);
                Assert(toggle != null, "找到 ToggleRow（点击处理所调用的方法）");
                if (toggle != null)
                {
                    string before = lv.Items[0].SubItems[0].Text;
                    toggle.Invoke(form, new object[] { 0 });
                    string after = lv.Items[0].SubItems[0].Text;
                    Assert(before != after && (after == "☑" || after == "☐"),
                        "勾选一行后首列字符改变：" + before + " → " + after);
                    Assert(GetStatusText(form).Contains("已勾选 1 个"), "状态栏计数随之更新：" + GetStatusText(form));
                    toggle.Invoke(form, new object[] { 5 });        // a different row
                    toggle.Invoke(form, new object[] { 0 });        // and back
                    Assert(GetStatusText(form).Contains("已勾选 1 个"), "再点另一行后计数为 2 或回退：" + GetStatusText(form));
                }
            }
            Console.WriteLine("");
            Console.WriteLine("=== 任务队列面板（分组、可追加、可续跑）===");
            // Shared with the run-state section below: set the flag, then let UpdateButtons decide.
            var runningField = typeof(MainForm).GetField("_running", BindingFlags.NonPublic | BindingFlags.Instance);
            var update = typeof(MainForm).GetMethod("UpdateButtons", BindingFlags.NonPublic | BindingFlags.Instance);
            // The queue writes work\queue.json through its real handlers, so the file is put back
            // exactly as it was at the end of this section: running the check must not disturb the
            // user's queue. Nothing else the queue touches is persisted — no game data, no cache.
            string queuePath = System.IO.Path.Combine(root, "work", "queue.json");
            bool hadQueue = System.IO.File.Exists(queuePath);
            byte[] queueBackup = hadQueue ? System.IO.File.ReadAllBytes(queuePath) : null;

            var trees = all.OfType<TreeView>().ToList();
            Assert(trees.Count == 1, "恰好一个 TreeView（队列的组 → 成员）数量=" + trees.Count);
            var summaryLabels = all.OfType<Label>().Select(l => l.Text ?? "")
                .Where(t => t.StartsWith("队列")).ToList();
            Assert(summaryLabels.Count == 1, "有一行队列摘要：" + (summaryLabels.Count > 0 ? summaryLabels[0] : "无"));

            foreach (var want in new[] { "新建组并加入选中", "加入选中到所选组", "移出选中",
                                         "清空队列", "跳过本组", "开始队列" })
                Assert(buttons.Any(t => t.Contains(want)), "队列按钮存在：" + want);

            Assert(byText.ContainsKey("跳过本组") && !byText["跳过本组"].Enabled, "未运行时「跳过本组」为禁用");
            // The queue is the user's, and this check runs against the real install: it may well already
            // hold groups the user built. So these assert the INVARIANT (enabled exactly when the queue has
            // something to act on) rather than an empty queue — an earlier version asserted "disabled
            // because the queue is empty" and reported five failures the moment the feature was used.
            var queueField0 = typeof(MainForm).GetField("_queue", BindingFlags.NonPublic | BindingFlags.Instance);
            int groupsAtStart = queueField0 == null ? 0 : ((System.Collections.IList)queueField0.GetValue(form)).Count;
            Console.WriteLine("        开始时队列里已有 " + groupsAtStart + " 组（来自用户的 work\\queue.json）");
            Assert(byText.ContainsKey("开始队列") && byText["开始队列"].Enabled == (groupsAtStart > 0),
                "「开始队列」的可用性与「队列非空」一致（现有 " + groupsAtStart + " 组）");
            Assert(byText.ContainsKey("清空队列") && byText["清空队列"].Enabled == (groupsAtStart > 0),
                "「清空队列」的可用性与「队列非空」一致");

            var addNewGroup = typeof(MainForm).GetMethod("AddCheckedToNewGroup", BindingFlags.NonPublic | BindingFlags.Instance);
            var saveQueue = typeof(MainForm).GetMethod("SaveQueue", BindingFlags.NonPublic | BindingFlags.Instance);
            var loadQueue = typeof(MainForm).GetMethod("LoadQueue", BindingFlags.NonPublic | BindingFlags.Instance);
            var queueField = typeof(MainForm).GetField("_queue", BindingFlags.NonPublic | BindingFlags.Instance);
            Assert(addNewGroup != null && saveQueue != null && loadQueue != null && queueField != null,
                "找到队列的私有成员（AddCheckedToNewGroup / SaveQueue / LoadQueue / _queue）");
            if (addNewGroup != null && saveQueue != null && loadQueue != null && queueField != null)
            {
                // At least one game is checked at this point (the toggle test above left one ticked), so
                // 新建组并加入选中 must append exactly one group holding the ticked games.
                int checkedNow = CountChecked(form);
                Console.WriteLine("        当前已勾选：" + checkedNow + " 个");
                addNewGroup.Invoke(form, null);
                var q = (System.Collections.IList)queueField.GetValue(form);
                Assert(q.Count == groupsAtStart + 1, "新建组后组数 +1（" + groupsAtStart + " → " + q.Count + "）");
                if (q.Count > groupsAtStart)
                {
                    var grp = q[q.Count - 1];                       // the group just appended
                    var tasks = (System.Collections.IList)grp.GetType().GetField("Tasks").GetValue(grp);
                    Assert(tasks.Count == checkedNow && tasks.Count > 0,
                        "新组包含勾选的 " + checkedNow + " 个任务（实际 " + tasks.Count + "）");
                }
                Assert(trees.Count == 1 && trees[0].Nodes.Count == q.Count,
                    "树里有 " + q.Count + " 个组节点");
                if (trees.Count == 1 && trees[0].Nodes.Count > 0)
                {
                    var last = trees[0].Nodes[trees[0].Nodes.Count - 1];
                    Console.WriteLine("        新组节点: " + last.Text);
                    Assert(last.Text.Contains("第 " + q.Count + " 组"),
                        "新组节点编号正确：" + last.Text);
                    Assert(last.Nodes.Count == checkedNow, "新组节点下挂着勾选的成员");
                }
                var sumText = all.OfType<Label>().Select(l => l.Text ?? "").FirstOrDefault(t => t.StartsWith("队列")) ?? "";
                Assert(sumText.Contains(q.Count + " 组") && sumText.Contains("个任务"),
                    "摘要显示组数与任务数：" + sumText);
                update.Invoke(form, null);
                Assert(byText["开始队列"].Enabled, "队列非空后「开始队列」可用");
                Assert(byText["清空队列"].Enabled, "队列非空后「清空队列」可用");

                // Persistence round trip, on a temporary file so the real queue.json is never written.
                string tmp = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "gt-uicheck-queue-" + Guid.NewGuid().ToString("N") + ".json");
                saveQueue.Invoke(form, new object[] { tmp });
                Assert(System.IO.File.Exists(tmp), "队列已写出到临时文件");
                loadQueue.Invoke(form, new object[] { tmp });
                var q2 = (System.Collections.IList)queueField.GetValue(form);
                Assert(q2.Count == q.Count, "重新读取后组数一致（" + q2.Count + "）");
                string raw = System.IO.File.ReadAllText(tmp);
                Console.WriteLine("        queue.json: " + (raw.Length > 120 ? raw.Substring(0, 120) + "…" : raw));
                Assert(raw.Contains("\"Group\":1") && raw.Contains("\"GroupState\""), "队列文件字段齐全");
                System.IO.File.Delete(tmp);
            }

            Console.WriteLine("");
            Console.WriteLine("=== 运行中左侧仍可操作（模拟 _running=true 后重算按钮）===");
            // The window used to grey out the whole game list and every selection button for the
            // duration of a batch, so it could not be scrolled and nothing could be unchecked.
            // _running is private, so it is set through reflection and UpdateButtons re-run — that
            // exercises the real decision instead of restating it.
            var runningField2 = typeof(MainForm).GetField("_running", BindingFlags.NonPublic | BindingFlags.Instance);
            var update2 = typeof(MainForm).GetMethod("UpdateButtons", BindingFlags.NonPublic | BindingFlags.Instance);
            if (runningField2 == null || update2 == null) Assert(false, "找到 _running 与 UpdateButtons（反射）");
            else
            {
                runningField2.SetValue(form, true);
                update2.Invoke(form, null);
                Assert(gameList != null && gameList.Enabled, "运行中：游戏列表仍可滚动/选择/右键");
                Assert(byText["全选"].Enabled && byText["取消全选"].Enabled, "运行中：全选/取消全选可用");
                Assert(byText["终止"].Enabled && byText["暂停"].Enabled, "运行中：终止/暂停可用");
                Assert(!byText["扫描全部路径"].Enabled && !byText["添加游戏"].Enabled && !byText["刷新状态"].Enabled,
                    "运行中：会改动列表的按钮停用（扫描/添加/刷新状态）");
                // The queue is the exception on purpose: a running group re-reads its task list before
                // every game, so a task added now really does run in the same pass. The buttons that
                // rewrite the queue's order would fight the loop, so those wait.
                Assert(byText["新建组并加入选中"].Enabled, "运行中：仍可把选中游戏加进新的组");
                Assert(byText["加入选中到所选组"].Enabled, "运行中：仍可把选中游戏加进所选组");
                Assert(byText["跳过本组"].Enabled, "运行中：「跳过本组」可用");
                Assert(!byText["移出选中"].Enabled && !byText["清空队列"].Enabled && !byText["开始队列"].Enabled,
                    "运行中：移出/清空/开始队列停用（会与循环打架）");
                runningField2.SetValue(form, false);
                update2.Invoke(form, null);
                Assert(!byText["终止"].Enabled, "模拟结束后回到未运行态");
                Assert(!byText["跳过本组"].Enabled, "模拟结束后「跳过本组」回到禁用");
            }

            // Put the user's queue file back exactly as it was, so running the check is invisible to it.
            if (hadQueue) System.IO.File.WriteAllBytes(queuePath, queueBackup);
            else if (System.IO.File.Exists(queuePath)) System.IO.File.Delete(queuePath);

            Console.WriteLine("");
            Console.WriteLine("=== 进度列的文件名必须与管线一致 ===");
            // The pipeline names its work files with its own sanitizer (alnum + CJK kept, everything else
            // "_", cut at 60). The window must derive the same stem or it can never find the report — it
            // used to keep every non-ASCII character and drop punctuation, so "My Game ver1.10" became
            // "MyGamever110" while the file on disk is "My_Game_ver1_10-translate-report.json".
            {
                var stemOf = typeof(MainForm).GetMethod("WorkStem", BindingFlags.NonPublic | BindingFlags.Static);
                Assert(stemOf != null, "找到 WorkStem（文件名推导）");
                if (stemOf != null)
                {
                    var cases = new[]
                    {
                        new[] { @"D:\games\My Game ver1.10\My Game ver1.10", "My_Game_ver1_10" },
                        new[] { @"D:\games\Sample Title - Part A & Part B", "Sample_Title___Part_A___Part_B" },
                        new[] { @"D:\games\plain_name_1001", "plain_name_1001" },
                    };
                    foreach (var c in cases)
                    {
                        var got = Convert.ToString(stemOf.Invoke(null, new object[] { c[0] }));
                        Assert(got == c[1], "WorkStem(" + System.IO.Path.GetFileName(c[0]) + ") = " + got + "（应为 " + c[1] + "）");
                    }
                }
            }

            Console.WriteLine("");
            Console.WriteLine("=== 翻译对照面板（实时显示原文/译文）===");
            {
                var srcBox = FindControl(form, "pairSrc") as TextBox;
                var dstBox = FindControl(form, "pairDst") as TextBox;
                var list = FindControl(form, "pairList") as ListView;
                var auto = FindControl(form, "pairAuto") as CheckBox;
                var count = FindControl(form, "pairCount") as Label;
                var log = FindControl(form, "log") as TextBox;
                Assert(srcBox != null && dstBox != null, "有原文/译文两个显示框");
                Assert(list != null, "有历史对照列表");
                Assert(auto != null && auto.Checked, "有「自动滚动」开关且默认开启");
                Assert(count != null && count.Text.Contains("0 条"), "有计数标签且初值为 0");
                Assert(srcBox != null && dstBox != null && srcBox.ReadOnly && dstBox.ReadOnly, "两个对照框只读");
                Assert(srcBox != null && srcBox.Multiline, "对照框可显示多行");
                Assert(log != null, "找到日志框（用于确认 PAIR 不进日志）");

                // Drive the real display path with the line the pipeline emits, so both the parse and the
                // widgets are exercised. The text deliberately contains a quote and a newline: the pipeline
                // escapes them through JSON.stringify, and that is the property that keeps one pair on one
                // output line.
                var onLine = typeof(MainForm).GetMethod("OnPipelineLine", BindingFlags.NonPublic | BindingFlags.Instance);
                var clear = typeof(MainForm).GetMethod("ClearPairs", BindingFlags.NonPublic | BindingFlags.Instance);
                Assert(onLine != null && clear != null, "找到 OnPipelineLine / ClearPairs（反射）");
                if (onLine != null && list != null && srcBox != null && dstBox != null && count != null && log != null)
                {
                    string src = "\u300c\u304a\u306f\u3088\u3046\u3001\"\u5148\u751f\"\u300d\n\u4eca\u65e5\u306f\u3044\u3044\u5929\u6c17\u3067\u3059\u306d\u3002";
                    string dst = "\u300c\u65e9\u4e0a\u597d\uff0c\u201c\u8001\u5e08\u201d\u300d\n\u4eca\u5929\u5929\u6c14\u771f\u597d\u3002";
                    string logBefore = log.Text;
                    onLine.Invoke(form, new object[] { PairLine(src, dst) });
                    Assert(srcBox.Text == src, "原文框显示完整原文（含引号与换行）");
                    Assert(dstBox.Text == dst, "译文框显示完整译文");
                    Assert(list.Items.Count == 1, "历史列表新增 1 行，实际 " + list.Items.Count);
                    Assert(list.Items.Count == 1 && list.Items[0].SubItems[0].Text.IndexOf('\n') < 0,
                        "列表单元格把换行折成空格");
                    Assert(count.Text.Contains("1 条"), "计数更新：" + count.Text);
                    Assert(log.Text == logBefore, "PAIR 行没有进日志");

                    onLine.Invoke(form, new object[] { PairLine("\u3042", "\u554a") });
                    Assert(list.Items.Count == 2 && list.Items[0].SubItems[0].Text == "\u3042", "最新的排在最前");

                    if (clear != null)
                    {
                        clear.Invoke(form, null);
                        Assert(list.Items.Count == 0 && srcBox.Text == "" && count.Text.Contains("0 条"),
                            "清空后对照面板回到初始状态");
                    }
                }
            }

            Console.WriteLine("");
            Console.WriteLine("=== 布局：任务控制在左，翻译对照占满剩余高度 ===");
            {
                // The task controls used to be a row in the right column, where the height they took
                // came straight out of the 翻译对照 panel — the one area that has to be big, since it
                // is the only place the running translation can be read. They now share the left pane
                // with the game list, and the pair panel takes every pixel the fixed rows do not need.
                var lvGame = Flatten(form).OfType<ListView>().FirstOrDefault(l => l.VirtualMode);
                var lvPair = FindControl(form, "pairList") as ListView;
                var boxPair = lvPair == null ? null : lvPair.Parent;
                var txtLog = FindControl(form, "log") as TextBox;
                var boxLog = txtLog == null ? null : txtLog.Parent;
                var btnStartSel = Flatten(form).OfType<Button>().FirstOrDefault(b => b.Text == "开始汉化选中");
                var btnStartAll = Flatten(form).OfType<Button>().FirstOrDefault(b => b.Text == "全部汉化");

                // The pane a control belongs to is the SplitContainer's panel, not the split: walking
                // up to the control whose parent is a SplitterPanel is what tells left from right.
                Func<Control, Control> paneOf = c =>
                {
                    var p = c;
                    while (p != null && p.Parent != null && !(p.Parent is SplitterPanel)) p = p.Parent;
                    return p;
                };
                Assert(btnStartSel != null && btnStartAll != null, "找到任务控制按钮（开始汉化选中 / 全部汉化）");
                Assert(btnStartSel != null && lvGame != null && paneOf(btnStartSel) != null && paneOf(btnStartSel) == paneOf(lvGame),
                    "任务控制与游戏列表在同一个（左侧）面板里");
                Assert(txtLog != null && lvGame != null && paneOf(txtLog) != null && paneOf(txtLog) == paneOf(lvGame),
                    "日志也在左侧面板里（右边整列留给翻译对照）");
                Assert(lvPair != null && lvGame != null && paneOf(lvPair) != null && paneOf(lvPair) != paneOf(lvGame),
                    "翻译对照在另一个（右侧）面板里");
                Assert(boxPair != null && boxLog != null, "找到翻译对照容器与日志容器");
                if (boxPair != null && boxLog != null)
                {
                    Console.WriteLine("        翻译对照容器高 " + boxPair.Height + " px，日志容器高 " + boxLog.Height + " px");
                    Assert(boxPair.Dock == DockStyle.Fill, "翻译对照容器 Dock=Fill（吃下全部剩余高度）");
                    Assert(boxLog.Dock == DockStyle.Bottom, "日志容器 Dock=Bottom（固定高度）");
                    Assert(boxPair.Height > boxLog.Height,
                        "翻译对照比日志高：" + boxPair.Height + " > " + boxLog.Height);
                }
                var txtPairSrc = FindControl(form, "pairSrc") as TextBox;
                Assert(txtPairSrc != null && txtPairSrc.Height >= 44,
                    "原文/译文框已加高：" + (txtPairSrc == null ? "-" : txtPairSrc.Height + " px"));
                // The history list is what "see a bigger range" means: it must be the bulk of the
                // panel, not a two-row footnote.
                Console.WriteLine("        对照历史列表高 " + (lvPair == null ? 0 : lvPair.Height) + " px（约 " +
                    (lvPair == null ? 0 : Math.Max(0, (lvPair.Height - 8) / 24)) + " 行）");
                Assert(lvPair != null && lvPair.Height >= 200, "对照历史列表至少 200 px 高（约 8 行）");
            }

            Console.WriteLine("");
            Console.WriteLine("=== 云端 API 模式（密钥不入库、模型链、状态显示）===");
            {
                var settingsField = typeof(MainForm).GetField("_settings", BindingFlags.NonPublic | BindingFlags.Instance);
                var applyState = typeof(MainForm).GetMethod("ApplyModelState", BindingFlags.NonPublic | BindingFlags.Instance);
                var chainMethod = typeof(MainForm).GetMethod("BuildModelChain", BindingFlags.NonPublic | BindingFlags.Instance);
                Assert(settingsField != null && applyState != null && chainMethod != null,
                    "找到 _settings / ApplyModelState / BuildModelChain（反射）");
                var settings = settingsField == null ? null : settingsField.GetValue(form) as GameTranslatorV3.Core.Settings;
                Assert(settings != null, "取到设置对象");
                if (settings != null && chainMethod != null && applyState != null)
                {
                    bool oldUse = settings.UseApi;
                    string oldModel = settings.ApiModel;
                    string oldChain = settings.ApiModels;
                    settings.ApiModel = "alpha";
                    settings.ApiModels = "alpha, beta ,alpha,gamma";
                    var chain = Convert.ToString(chainMethod.Invoke(form, null));
                    Assert(chain == "alpha,beta,gamma", "模型链：选中项在前、去重去空格 → " + chain);

                    settings.UseApi = true;
                    applyState.Invoke(form, null);
                    var apiState = Flatten(form).OfType<Label>().FirstOrDefault(l => (l.Text ?? "").StartsWith("状态："));
                    Assert(apiState != null && apiState.Text.Contains("云端 API"),
                        "云端模式的状态显示：" + (apiState == null ? "无" : apiState.Text));

                    settings.UseApi = oldUse; settings.ApiModel = oldModel; settings.ApiModels = oldChain;
                    applyState.Invoke(form, null);
                    Assert(Flatten(form).OfType<Label>().Any(l => (l.Text ?? "").StartsWith("状态：")), "恢复后状态行仍在");
                    // Leave LOCAL mode on for the sections below: they assert the local readout
                    // (未启动 / 已就绪 / 实际≠所选), and a deployment that has cloud mode switched on would
                    // otherwise answer every one of them with the cloud line.
                    settings.UseApi = false;
                    applyState.Invoke(form, null);
                }

                // The cloud catalogue mixes non-LLMs in; the dropdown must only offer text models.
                var parseIds = typeof(MainForm).GetMethod("ParseModelIds", BindingFlags.NonPublic | BindingFlags.Static);
                Assert(parseIds != null, "找到 ParseModelIds（反射）");
                if (parseIds != null)
                {
                    var body = "{\"data\":[{\"id\":\"qwen-mt-plus\"},{\"id\":\"qwen-plus\"},{\"id\":\"qwen-vl-max\"}," +
                               "{\"id\":\"text-embedding-v3\"},{\"id\":\"gte-rerank-v2\"},{\"id\":\"cosyvoice-v1\"}," +
                               "{\"id\":\"wanx-v1\"},{\"id\":\"qwen3-livetranslate-flash\"},{\"id\":\"qwen3.8-omni-flash-realtime\"}," +
                               "{\"id\":\"deepseek-v3\"}]}";
                    var ids = parseIds.Invoke(null, new object[] { body }) as List<string>;
                    Assert(ids != null && ids.Count == 3 && ids.Contains("qwen-mt-plus") && ids.Contains("qwen-plus") && ids.Contains("deepseek-v3"),
                        "云端列表只留大语言模型：" + (ids == null ? "null" : string.Join(",", ids.ToArray())));
                    Assert(ids != null && !ids.Contains("qwen-vl-max") && !ids.Contains("text-embedding-v3") &&
                        !ids.Contains("gte-rerank-v2") && !ids.Contains("cosyvoice-v1") && !ids.Contains("wanx-v1"),
                        "视觉 / 向量 / 重排 / 语音 / 图像模型不出现在列表里");
                    Assert(ids != null && !ids.Contains("qwen3-livetranslate-flash") && !ids.Contains("qwen3.8-omni-flash-realtime"),
                        "语音对语音（livetranslate / realtime）模型不出现在列表里");
                }

                // Picking a model in the dropdown must have an effect. The chain handed to the pipeline is built
                // from _settings.ApiModel, and until this existed that field was written only while refreshing
                // the list — so choosing another model changed nothing, and 刷新列表 snapped the selection back.
                var onSel = typeof(MainForm).GetMethod("OnModelSelectionChanged", BindingFlags.NonPublic | BindingFlags.Instance);
                var chainIds = typeof(MainForm).GetMethod("ChainModelIds", BindingFlags.NonPublic | BindingFlags.Static);
                var cmb = FindControl(form, "cmbModel") as ComboBox;
                Assert(onSel != null && chainIds != null && cmb != null,
                    "找到 OnModelSelectionChanged / ChainModelIds（下拉框选择会被记录）");
                if (onSel != null && chainIds != null && cmb != null && settings != null && chainMethod != null)
                {
                    var list = chainIds.Invoke(null, new object[] { "qwen-plus", "qwen-plus, qwen-mt-plus, qwen-vl-max,qwen-turbo" }) as List<string>;
                    Assert(list != null && string.Join(",", list.ToArray()) == "qwen-plus,qwen-mt-plus,qwen-turbo",
                        "取不到云端列表时的候选链：选中项在前、去重、排除非文本模型 → " +
                        (list == null ? "null" : string.Join(",", list.ToArray())));

                    // The dropdown is the real one (it may hold the live catalogue, whose names would collide with
                    // any invented test model), so the whole item list is snapshotted and put back afterwards.
                    var savedItems = cmb.Items.Cast<object>().ToArray();
                    int savedIdx = cmb.SelectedIndex;
                    bool savedUse = settings.UseApi;
                    string savedApi = settings.ApiModel;
                    string savedLocal = settings.Model;

                    cmb.Items.Clear();
                    cmb.Items.AddRange(new object[] { "qwen-mt-plus", "unit-cloud-model", "qwen-vl-max" });
                    settings.UseApi = true;
                    settings.ApiModel = "qwen-mt-plus";

                    cmb.SelectedIndex = 1;
                    onSel.Invoke(form, null);
                    Assert(settings.ApiModel == "unit-cloud-model", "云端模式：下拉框选的模型被记录 → " + settings.ApiModel);
                    Assert(Convert.ToString(chainMethod.Invoke(form, null)).StartsWith("unit-cloud-model"),
                        "所选模型成为模型链第一项 → " + Convert.ToString(chainMethod.Invoke(form, null)));

                    cmb.SelectedIndex = 2;
                    onSel.Invoke(form, null);
                    Assert(settings.ApiModel == "unit-cloud-model", "非文本模型不会被记成所选 → " + settings.ApiModel);

                    settings.UseApi = false;
                    cmb.SelectedIndex = 1;
                    onSel.Invoke(form, null);
                    Assert(settings.Model == "unit-cloud-model", "本地模式：选择记入 Model → " + settings.Model);

                    cmb.Items.Clear();
                    cmb.Items.AddRange(savedItems);
                    settings.UseApi = savedUse;
                    settings.ApiModel = savedApi;
                    settings.Model = savedLocal;
                    if (savedIdx >= 0 && savedIdx < cmb.Items.Count) cmb.SelectedIndex = savedIdx;
                }

                // The key lives in its own file (gitignored), never in the settings file or the source.
                var tmpDir = Path.Combine(Path.GetTempPath(), "gt-uicheck-api-" + Environment.TickCount.ToString());
                Directory.CreateDirectory(tmpDir);
                var savedOk = GameTranslatorV3.Core.Settings.SaveApiKey(tmpDir, "unit-test-placeholder");
                var readBack = GameTranslatorV3.Core.Settings.LoadApiKey(tmpDir);
                Assert(savedOk, "API Key 能写入 api-config.json");
                Assert(readBack == "unit-test-placeholder", "读回来一致（实际 " + readBack + "）");
                Assert(GameTranslatorV3.Core.Settings.ApiConfigPath(tmpDir).EndsWith("api-config.json", StringComparison.OrdinalIgnoreCase),
                    "密钥文件名是 api-config.json（.gitignore 已忽略，不进版本库）");
                var ini = File.Exists(Path.Combine(tmpDir, "ui-settings.ini"));
                Assert(!ini, "设置文件里没有密钥（此目录还没有 ini）");
                try { Directory.Delete(tmpDir, true); } catch { }
            }

            Console.WriteLine("");
            Console.WriteLine("=== 模型状态必须反映服务器实际加载的模型 ===");
            // The label used to show whatever the dropdown said. Measured on this machine: two llama-server
            // processes can hold the same port (llama.cpp sets SO_REUSEADDR and Windows allows the second
            // bind), so picking a smaller model and pressing 启动模型 loaded a second model into a 6 GB card
            // while every request still went to the first. The label has to read the model from the server.
            {
                var apply = typeof(MainForm).GetMethod("ApplyModelState", BindingFlags.NonPublic | BindingFlags.Instance);
                var ask = typeof(MainForm).GetMethod("AskLoadedModel", BindingFlags.NonPublic | BindingFlags.Static);
                var ownerM = typeof(MainForm).GetMethod("PortOwner", BindingFlags.NonPublic | BindingFlags.Static);
                var upField = typeof(MainForm).GetField("_modelUp", BindingFlags.NonPublic | BindingFlags.Instance);
                var serverField = typeof(MainForm).GetField("_serverModel", BindingFlags.NonPublic | BindingFlags.Instance);
                var state = Flatten(form).OfType<Label>().FirstOrDefault(l => (l.Text ?? "").StartsWith("状态："));
                Assert(apply != null && ask != null && ownerM != null && upField != null && serverField != null,
                    "找到 ApplyModelState / AskLoadedModel / PortOwner / _modelUp / _serverModel（反射）");
                Assert(state != null, "找到模型状态标签：" + (state == null ? "无" : state.Text));
                if (apply != null && upField != null && serverField != null && state != null)
                {
                    string selected = ReadSetting(form, "Model");

                    // 1) nothing listening
                    upField.SetValue(form, false);
                    apply.Invoke(form, null);
                    Assert(state.Text.Contains("未启动"), "未监听时显示未启动：" + state.Text);

                    // 2) listening, and the server reports exactly what the dropdown selects
                    upField.SetValue(form, true);
                    serverField.SetValue(form, selected);
                    apply.Invoke(form, null);
                    Assert(state.Text.Contains("已就绪") && !state.Text.Contains("非所选"),
                        "实际模型与所选一致时不报警：" + state.Text);

                    // 3) listening, but the server reports a DIFFERENT model — the case that misled
                    string other = string.Equals(selected, "Hy-MT2-1.8B-Q8_0.gguf", StringComparison.OrdinalIgnoreCase)
                        ? "Galtransl-v4-4B-2601.gguf" : "Hy-MT2-1.8B-Q8_0.gguf";
                    serverField.SetValue(form, other);
                    apply.Invoke(form, null);
                    Assert(state.Text.Contains("实际") && state.Text.Contains("非所选"),
                        "实际与所选不一致时明确标出：" + state.Text);
                    Console.WriteLine("        不一致时的状态文字: " + state.Text);

                    // 4) answering but /props unreadable must not imply the selection is running
                    serverField.SetValue(form, null);
                    upField.SetValue(form, true);
                    apply.Invoke(form, null);
                    Assert(state.Text.Contains("模型未知"), "读不到 /props 时说未知：" + state.Text);

                    // leave the label as it was found
                    serverField.SetValue(form, null);
                    upField.SetValue(form, false);
                    apply.Invoke(form, null);
                }

                // The port owner lookup is real: if something listens on the configured port, its PID must
                // come back — this is what lets 启动模型 reclaim a port a previous run left behind. It
                // returns a LIST because two processes can hold one port on Windows.
                var ownersM = typeof(MainForm).GetMethod("PortOwners", BindingFlags.NonPublic | BindingFlags.Static);
                Assert(ownersM != null, "找到 PortOwners（查找占用端口的进程）");
                if (ownersM != null)
                {
                    int appPort = 0;
                    int.TryParse(ReadSetting(form, "Port"), out appPort);
                    var owners = (System.Collections.IEnumerable)ownersM.Invoke(null, new object[] { appPort });
                    var list = new List<int>();
                    foreach (var o in owners) list.Add(Convert.ToInt32(o));
                    Console.WriteLine("        端口 " + appPort + " 的监听者: " + (list.Count == 0 ? "无" : string.Join("、", list.ConvertAll(x => "PID " + x).ToArray())));
                    Assert(list.TrueForAll(p => p > 0), "返回的 PID 都是正数");
                    foreach (var pid in list)
                    {
                        var proc = System.Diagnostics.Process.GetProcessById(pid);
                        Assert(proc != null, "PID " + pid + " 可解析为进程：" + (proc == null ? "" : proc.ProcessName));
                    }
                    // and a port nobody listens on must come back empty
                    var none = (System.Collections.IEnumerable)ownersM.Invoke(null, new object[] { 1 });
                    int n = 0;
                    foreach (var o in none) n++;
                    Assert(n == 0, "无人监听的端口返回空列表（实际 " + n + "）");
                }
            }

            Console.WriteLine("");
            Console.WriteLine("=== 暂停是真的会停（协作式标记文件）===");
            // Pausing only between games meant the button looked dead for as long as the current game took,
            // which on a large one is hours — reported as "暂停失效". The window now drops a flag the
            // translate loop watches between REQUESTS, so this checks the file really appears and goes away.
            {
                var pauseM = typeof(MainForm).GetMethod("Pause", BindingFlags.NonPublic | BindingFlags.Instance);
                var resumeM = typeof(MainForm).GetMethod("Resume", BindingFlags.NonPublic | BindingFlags.Instance);
                var pathP = typeof(MainForm).GetProperty("PauseFlagPath", BindingFlags.NonPublic | BindingFlags.Instance);
                var clearM = typeof(MainForm).GetMethod("ClearStalePauseFlag", BindingFlags.NonPublic | BindingFlags.Instance);
                Assert(pauseM != null && resumeM != null && pathP != null && clearM != null,
                    "找到 Pause / Resume / PauseFlagPath / ClearStalePauseFlag（反射）");
                if (pauseM != null && resumeM != null && pathP != null)
                {
                    string flag = Convert.ToString(pathP.GetValue(form, null));
                    Console.WriteLine("        标记文件: " + flag);
                    Assert(!string.IsNullOrEmpty(flag) && Path.GetFileName(flag) == "paused.flag",
                        "标记文件名为 paused.flag");
                    // start from a known state
                    if (File.Exists(flag)) File.Delete(flag);
                    pauseM.Invoke(form, null);
                    Assert(File.Exists(flag), "点「暂停」后标记文件出现");
                    resumeM.Invoke(form, null);
                    Assert(!File.Exists(flag), "点「继续」后标记文件消失");
                    // and a leftover flag is dropped when a run starts, or the next run would wait forever
                    File.WriteAllText(flag, "leftover");
                    if (clearM != null) clearM.Invoke(form, null);
                    Assert(!File.Exists(flag), "运行开始时清除遗留标记");
                    // the pipeline must be watching this exact path
                    var pipeJs = File.ReadAllText(Path.Combine(root, "pipeline", "index.js"));
                    Assert(pipeJs.Contains("paused.flag"), "管线读取同一个 paused.flag");
                    var trJs = File.ReadAllText(Path.Combine(root, "pipeline", "translate", "index.js"));
                    Assert(trJs.Contains("waitWhilePaused"), "translate 阶段实现了 waitWhilePaused");
                }
            }

            Console.WriteLine("");
            Console.WriteLine("=== 速度/预计：tok/s、条/分、完成时间 ===");
            {
                var etaLabel = Flatten(form).OfType<Label>().FirstOrDefault(l => (l.Text ?? "").StartsWith("预计"));
                Assert(etaLabel != null, "任务进度里有「预计」行：" + (etaLabel == null ? "无" : etaLabel.Text));
                var rateLabel = Flatten(form).OfType<Label>().FirstOrDefault(l => (l.Text ?? "").StartsWith("速度"));
                Assert(rateLabel != null, "任务进度里有「速度」行：" + (rateLabel == null ? "无" : rateLabel.Text));

                // The Prometheus body is parsed, not substring-searched: the # HELP line carries the same
                // metric name and its value column is a word, which is what a naive search picks up.
                var parse = typeof(MainForm).GetMethod("ParsePredictedTokens", BindingFlags.NonPublic | BindingFlags.Static);
                Assert(parse != null, "找到 ParsePredictedTokens（反射）");
                if (parse != null)
                {
                    string sample = "# HELP llamacpp:tokens_predicted_total Number of tokens predicted\n" +
                                    "# TYPE llamacpp:tokens_predicted_total counter\n" +
                                    "llamacpp:tokens_predicted_total 410353\n" +
                                    "llamacpp:prompt_tokens_total 357431\n";
                    long got = Convert.ToInt64(parse.Invoke(null, new object[] { sample }));
                    Assert(got == 410353, "真实 /metrics 文本解析出 410353（实际 " + got + "）");
                    long none = Convert.ToInt64(parse.Invoke(null, new object[] { "# HELP x Total\nllamacpp:prompt_tokens_total 5\n" }));
                    Assert(none == -1, "没有该指标时返回 -1（实际 " + none + "）");
                    long empty = Convert.ToInt64(parse.Invoke(null, new object[] { "" }));
                    Assert(empty == -1, "空文本返回 -1");
                }

                var span = typeof(MainForm).GetMethod("FormatSpan", BindingFlags.NonPublic | BindingFlags.Static);
                Assert(span != null, "找到 FormatSpan（时长格式）");
                if (span != null)
                {
                    var cases = new object[][]
                    {
                        new object[] { 3725.0, "1 小时 2 分" },      // 1h 2m 5s
                        new object[] { 750.0, "12 分 30 秒" },
                        new object[] { 45.0, "45 秒" },
                        new object[] { 0.4, "1 秒" },                 // never "0 秒" for a positive estimate
                    };
                    foreach (var c in cases)
                    {
                        var s = Convert.ToString(span.Invoke(null, new[] { c[0] }));
                        Assert(s == (string)c[1], "FormatSpan(" + c[0] + ") = " + s + "（应为 " + c[1] + "）");
                    }
                }

                // The sampling window is the feature's contract: 15 seconds.
                var win = typeof(MainForm).GetField("RateWindowSeconds", BindingFlags.NonPublic | BindingFlags.Static);
                Assert(win != null && Convert.ToInt32(win.GetRawConstantValue()) == 15,
                    "采样窗口为 15 秒（实际 " + (win == null ? "未找到" : Convert.ToString(win.GetRawConstantValue())) + "）");
                // and the two figures are computed somewhere on every tick
                var upd = typeof(MainForm).GetMethod("UpdateRates", BindingFlags.NonPublic | BindingFlags.Instance);
                Assert(upd != null, "找到 UpdateRates（每秒刷新、每 15 秒采样）");
            }

            Console.WriteLine("");
            Console.WriteLine("=== 窗口 ===");
            Console.WriteLine("        标题: " + form.Text + "   尺寸: " + form.Size);
            Console.WriteLine("");
            Console.WriteLine(_fail == 0 ? "全部通过 (" + _pass + " 项)" : _fail + " 项失败 / 共 " + (_pass + _fail) + " 项");

            form.Dispose();
            return _fail == 0 ? 0 : 1;
        }

        /// <summary>How many games are ticked, read from the status line the window maintains.</summary>
        private static int CountChecked(Form form)
        {
            var t = GetStatusText(form);
            int i = t.IndexOf("已勾选 ");
            if (i < 0) return 0;
            i += "已勾选 ".Length;
            int j = i;
            while (j < t.Length && char.IsDigit(t[j])) j++;
            int n;
            return int.TryParse(t.Substring(i, j - i), out n) ? n : 0;
        }

        private static IEnumerable<Control> Flatten(Control c)
        {
            yield return c;
            foreach (Control child in c.Controls)
                foreach (var x in Flatten(child))
                    yield return x;
        }

        /// <summary>A control by name, anywhere in the tree, or null. C# 5 has no local functions.</summary>
        private static Control FindControl(Form form, string name)
        {
            var hit = form.Controls.Find(name, true);
            return hit.Length > 0 ? hit[0] : null;
        }

        /// <summary>
        /// One value out of the form's Settings, via its field or its property — whichever the class uses.
        /// Returns null when it cannot be read, so a caller can skip the assertion instead of guessing.
        /// </summary>
        private static string ReadSetting(Form form, string name)
        {
            try
            {
                var sf = typeof(MainForm).GetField("_settings", BindingFlags.NonPublic | BindingFlags.Instance);
                if (sf == null) return null;
                object settings = sf.GetValue(form);
                if (settings == null) return null;
                var t = settings.GetType();
                var f = t.GetField(name, BindingFlags.Public | BindingFlags.Instance);
                if (f != null) return Convert.ToString(f.GetValue(settings));
                var p = t.GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
                if (p != null) return Convert.ToString(p.GetValue(settings, null));
            }
            catch { }
            return null;
        }

        /// <summary>The status line's text ("共 110 个游戏，已勾选 N 个").</summary>
        private static string GetStatusText(Form form)
        {
            var labels = Flatten(form).OfType<Label>().Select(l => l.Text ?? "");
            foreach (var t in labels) if (t.StartsWith("共 ")) return t;
            return "(not found)";
        }

        /// <summary>
        /// The line the pipeline emits for one pair. Built here with the same escaping JSON.stringify does
        /// on the other side, so the check exercises the real wire format rather than a simplified one.
        /// </summary>
        private static string PairLine(string src, string dst)
        {
            return "PAIR {\"src\":" + JsonStr(src) + ",\"dst\":" + JsonStr(dst) + "}";
        }

        private static string JsonStr(string s)
        {
            var outText = "\"";
            foreach (var c in s ?? "")
            {
                if (c == '"') outText += "\\\"";
                else if (c == '\\') outText += "\\\\";
                else if (c == '\n') outText += "\\n";
                else if (c == '\r') outText += "\\r";
                else if (c == '\t') outText += "\\t";
                else outText += c;
            }
            return outText + "\"";
        }
    }
}
