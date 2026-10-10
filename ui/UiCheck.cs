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
            Console.WriteLine("=== 功能按钮 ===");
            var buttons = all.OfType<Button>().Select(b => b.Text ?? "").ToList();
            Console.WriteLine("        按钮: " + string.Join(" | ", buttons));
            foreach (var want in new[] { "开始汉化选中", "全部汉化", "暂停", "继续", "终止",
                                         "检查翻译", "卸载汉化", "恢复汉化", "启动模型", "停止模型", "设置…" })
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
    }
}
