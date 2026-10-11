// Structural verification of the single-page UI.
//
// Instantiates MainForm, walks its control tree and asserts the things the user asked
// for: a model selector, a detailed progress panel, no tabs, and the expected buttons.
// This is stronger than a screenshot for layout questions — it names what is present.
using System;
using System.Collections.Generic;
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
            // used to keep every non-ASCII character and drop punctuation, so "NTR Police ver1.10" became
            // "NTRPolicever110" while the file on disk is "NTR_Police_ver1_10-translate-report.json".
            {
                var stemOf = typeof(MainForm).GetMethod("WorkStem", BindingFlags.NonPublic | BindingFlags.Static);
                Assert(stemOf != null, "找到 WorkStem（文件名推导）");
                if (stemOf != null)
                {
                    var cases = new[]
                    {
                        new[] { @"J:\game\HGAME\H\NTR Police ver1.10\NTR Police ver1.10", "NTR_Police_ver1_10" },
                        new[] { @"J:\x\NTR Sisters - Ciella & Luciella", "NTR_Sisters___Ciella___Luciella" },
                        new[] { @"J:\x\deadbunny_1001", "deadbunny_1001" },
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
