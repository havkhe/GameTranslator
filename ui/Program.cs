// Entry point. Any failure while starting the window is written to
// work\startup-error.log and shown in a message box, so the app never disappears
// silently — a silent exit was one of the harder v2 problems to diagnose.
//
// Startup is also traced step by step (work\startup-trace.log). A window can be created
// yet never become visible, and without a trace that looks like "the app will not open"
// with nothing to go on: the trace names the last step that completed.
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace GameTranslatorV3
{
    internal static class Program
    {
        private static string _root;

        private static void Trace(string step)
        {
            try
            {
                string dir = Path.Combine(_root ?? AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'), "work");
                Directory.CreateDirectory(dir);
                File.AppendAllText(Path.Combine(dir, "startup-trace.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "  pid=" +
                    System.Diagnostics.Process.GetCurrentProcess().Id + "  " + step + Environment.NewLine,
                    Encoding.UTF8);
            }
            catch { }
        }

        [STAThread]
        private static void Main()
        {
            _root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            Trace("start");
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Trace("visual styles set");

            // Only one window at a time.
            //
            // Without this, launching the exe again started a second instance whose window
            // opened at exactly the same place as the first, covering it. From the user's
            // side the app appeared not to open at all while three copies were running.
            bool owned;
            using (var single = new Mutex(true, @"Local\GameTranslatorV3_SingleInstance", out owned))
            {
                if (!owned)
                {
                    Trace("another instance is running; bringing it to the front and exiting");
                    BringExistingWindowToFront();
                    return;
                }

                // An exception on the UI thread would otherwise tear the app down with no
                // message at all in a release build.
                Application.ThreadException += (s, e) =>
                {
                    Trace("THREAD EXCEPTION: " + e.Exception);
                    TryLog(_root, e.Exception);
                    MessageBox.Show("运行中出错：\n\n" + e.Exception.Message +
                        "\n\n详细信息见 work\\startup-error.log", "错误",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                };
                AppDomain.CurrentDomain.UnhandledException += (s, e) =>
                {
                    Trace("UNHANDLED: " + e.ExceptionObject);
                    TryLog(_root, e.ExceptionObject as Exception ?? new Exception(Convert.ToString(e.ExceptionObject)));
                };

                try
                {
                    Trace("constructing MainForm");
                    using (var form = new MainForm(_root))
                    {
                        Trace("MainForm constructed; entering message loop");
                        Application.Run(form);
                        Trace("message loop exited");
                    }
                }
                catch (Exception ex)
                {
                    Trace("FATAL: " + ex);
                    TryLog(_root, ex);
                    MessageBox.Show(
                        "程序启动或运行中出错：\n\n" + ex.Message +
                        "\n\n详细信息已写入：\n" + Path.Combine(_root, "work", "startup-error.log"),
                        "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
            Trace("exit");
        }

        /// <summary>
        /// Raise the window of the instance already running.
        ///
        /// It is not enough to exit: the user asked for the app and would see nothing
        /// happen, which is the same complaint this fixes.
        /// </summary>
        private static void BringExistingWindowToFront()
        {
            try
            {
                var me = System.Diagnostics.Process.GetCurrentProcess();
                foreach (var p in System.Diagnostics.Process.GetProcessesByName(me.ProcessName))
                {
                    if (p.Id == me.Id) continue;
                    p.Refresh();
                    if (p.MainWindowHandle == IntPtr.Zero) continue;
                    ShowWindow(p.MainWindowHandle, SW_RESTORE);
                    SetForegroundWindow(p.MainWindowHandle);
                    Trace("raised window of pid " + p.Id);
                    return;
                }
            }
            catch (Exception ex) { Trace("could not raise the existing window: " + ex.Message); }
        }

        private const int SW_RESTORE = 9;

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

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
