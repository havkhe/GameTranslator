// Entry point. Any failure while starting the window is written to
// work\startup-error.log and shown in a message box, so the app never disappears
// silently — a silent exit was one of the harder v2 problems to diagnose.
using System;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace GameTranslatorV3
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            try
            {
                Application.Run(new MainForm(root));
            }
            catch (Exception ex)
            {
                TryLog(root, ex);
                MessageBox.Show(
                    "程序启动或运行中出错：\n\n" + ex.Message +
                    "\n\n详细信息已写入：\n" + Path.Combine(root, "work", "startup-error.log"),
                    "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static void TryLog(string root, Exception ex)
        {
            try
            {
                string dir = Path.Combine(root, "work");
                Directory.CreateDirectory(dir);
                File.AppendAllText(Path.Combine(dir, "startup-error.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + Environment.NewLine + ex + Environment.NewLine + Environment.NewLine,
                    Encoding.UTF8);
            }
            catch { }
        }
    }
}
