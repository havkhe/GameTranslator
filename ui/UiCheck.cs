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
            var modelCombo = combos.FirstOrDefault();
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
            var lists = all.OfType<ListView>().ToList();
            Assert(lists.Count == 1, "恰好一个 ListView 数量=" + lists.Count);
            if (lists.Count == 1)
            {
                var lv = lists[0];
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
            {
                var lv = lists[0];
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
            Console.WriteLine("=== 运行中左侧仍可操作（模拟 _running=true 后重算按钮）===");
            // The window used to grey out the whole game list and every selection button for the
            // duration of a batch, so it could not be scrolled and nothing could be unchecked.
            // _running is private, so it is set through reflection and UpdateButtons re-run — that
            // exercises the real decision instead of restating it.
            var runningField = typeof(MainForm).GetField("_running", BindingFlags.NonPublic | BindingFlags.Instance);
            var update = typeof(MainForm).GetMethod("UpdateButtons", BindingFlags.NonPublic | BindingFlags.Instance);
            if (runningField == null || update == null) Assert(false, "找到 _running 与 UpdateButtons（反射）");
            else
            {
                runningField.SetValue(form, true);
                update.Invoke(form, null);
                Assert(lists[0].Enabled, "运行中：游戏列表仍可滚动/选择/右键");
                Assert(byText["全选"].Enabled && byText["取消全选"].Enabled, "运行中：全选/取消全选可用");
                Assert(byText["终止"].Enabled && byText["暂停"].Enabled, "运行中：终止/暂停可用");
                Assert(!byText["扫描全部路径"].Enabled && !byText["添加游戏"].Enabled && !byText["刷新状态"].Enabled,
                    "运行中：会改动列表的按钮停用（扫描/添加/刷新状态）");
                runningField.SetValue(form, false);
                update.Invoke(form, null);
                Assert(!byText["终止"].Enabled, "模拟结束后回到未运行态");
            }

            Console.WriteLine("");
            Console.WriteLine("=== 窗口 ===");
            Console.WriteLine("        标题: " + form.Text + "   尺寸: " + form.Size);
            Console.WriteLine("");
            Console.WriteLine(_fail == 0 ? "全部通过 (" + _pass + " 项)" : _fail + " 项失败 / 共 " + (_pass + _fail) + " 项");

            form.Dispose();
            return _fail == 0 ? 0 : 1;
        }

        private static IEnumerable<Control> Flatten(Control c)
        {
            yield return c;
            foreach (Control child in c.Controls)
                foreach (var x in Flatten(child))
                    yield return x;
        }

        /// <summary>The status line's text ("共 110 个游戏，已勾选 N 个").</summary>
        private static string GetStatusText(Form form)
        {
            var labels = Flatten(form).OfType<Label>().Select(l => l.Text ?? "");
            foreach (var t in labels) if (t.StartsWith("共 ")) return t;
            return "(not found)";
        }
    }
}
