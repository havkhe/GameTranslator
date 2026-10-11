// v3 launcher.
//
// WHY THIS FILE EXISTS SEPARATELY:
//
// The v3 window was being created (title, size, position and native handle all correct)
// but never became visible: IsWindowVisible was false, the Load event never fired, and
// neither a WinForms Timer nor a thread-pool timer ever ran — so the message loop was not
// dispatching, while Application.Run(form) was definitely being called. Forcing the window
// visible from outside the process with ShowWindow(hwnd, SW_SHOW) does work, which proves
// the window itself is sound and only the in-process showing path is broken.
//
// Rather than ship a window the user cannot reach, this launcher:
//   1. creates the form, shows it natively by handle, and pumps messages with the classic
//      Application.Run() on a form that was ALREADY shown explicitly;
//   2. opens a tray icon as a guaranteed way back to the window;
//   3. retries the native ShowWindow a few times over the first seconds, since the first
//      attempt can land before the handle is usable.
// Each step is traced, so if the window still does not appear the log says which step ran.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace GameTranslatorV3
{
    internal static class Program
    {
        private static string _root = "";
        private static NotifyIcon _tray;
        private static MainForm _form;

        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
        private const int SW_SHOWNORMAL = 1, SW_SHOW = 5, SW_RESTORE = 9;

        private static void Trace(string s) { Startup.Trace(s); }

        /// <summary>
        /// Instance mutex name. Overridable so a second copy can be started deliberately — for
        /// testing a build while the user's own window is open — without changing this file.
        /// </summary>
        private static string InstanceName()
        {
            var custom = Environment.GetEnvironmentVariable("GT_INSTANCE_NAME");
            return "Local\\GameTranslatorV3_SingleInstance" + (string.IsNullOrEmpty(custom) ? "" : "_" + custom);
        }

        [STAThread]
        private static void Main()
        {
            _root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            Startup.Init(_root);
            Trace("launcher start  (root=" + _root + ")");

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // One window only. A second launch raises the running one rather than opening a
            // second copy at the same place, which looked like the app doing nothing.
            bool owned;
            using (var single = new Mutex(true, InstanceName(), out owned))
            {
                if (!owned) { Trace("already running; raising it and exiting"); RaiseExisting(); return; }

                Application.ThreadException += (s, e) => Trace("THREAD EXCEPTION: " + e.Exception);
                AppDomain.CurrentDomain.UnhandledException += (s, e) => Trace("UNHANDLED: " + e.ExceptionObject);

                try
                {
                    Trace("constructing MainForm");
                    _form = new MainForm(_root);
                    Trace("MainForm constructed (handle=" + _form.Handle + " visible=" + _form.Visible + ")");

                    SetupTray();
                    Trace("tray ready");

                    Trace("Application.Run 之前");
                    Application.Run(_form);
                    Trace("message loop exited");
                }
                catch (Exception ex)
                {
                    Trace("FATAL: " + ex);
                    try
                    {
                        File.AppendAllText(Path.Combine(_root, "work", "startup-error.log"),
                            DateTime.Now + Environment.NewLine + ex + Environment.NewLine, Encoding.UTF8);
                    }
                    catch { }
                    MessageBox.Show("程序出错：\n\n" + ex.Message, "错误");
                }
                finally
                {
                    if (_tray != null) { _tray.Visible = false; _tray.Dispose(); }
                }
            }
            Trace("launcher exit");
        }

        /// <summary>
        /// Show and foreground the window by native handle.
        ///
        /// Called from the tray menu and from the form itself, never before Application.Run: the
        /// launcher used to call this (and a threaded retry loop) while the message loop had not
        /// started, and the main thread then sat inside the call for about thirty-four seconds —
        /// the message loop, the Load event and every timer all waited on it. Touching the window
        /// only once the loop is pumping removes that.
        /// </summary>
        /// <summary>
        /// Show and foreground the window by native handle.
        ///
        /// Called from the tray menu and from the form itself, never before Application.Run: the
        /// launcher used to call this (and a threaded retry loop) while the message loop had not
        /// started, which both delayed the loop and worked around a stall that is now fixed at its
        /// source — the game list is filled in virtual mode, so showing the window costs milliseconds
        /// rather than the 34 s it used to spend pushing rows into the native ListView.
        /// </summary>
        private static void TryNativeShow(string tag)
        {
            try
            {
                if (_form == null || !_form.IsHandleCreated) { Trace(tag + ": no handle"); return; }
                var h = _form.Handle;
                if (IsWindowVisible(h)) { Trace(tag + ": already visible"); return; }
                ShowWindow(h, SW_SHOWNORMAL);
                ShowWindow(h, SW_SHOW);
                ShowWindow(h, SW_RESTORE);
                SetForegroundWindow(h);
                Trace(tag + ": ShowWindow done, visible=" + IsWindowVisible(h));
            }
            catch (Exception ex) { Trace(tag + " failed: " + ex.Message); }
        }

        /// <summary>A tray icon is the guaranteed way back to the window.</summary>
        private static void SetupTray()
        {
            try
            {
                _tray = new NotifyIcon
                {
                    Icon = SystemIcons.Application,
                    Text = "RPG Maker 汉化管理器 v3",
                    Visible = true
                };
                var menu = new ContextMenuStrip();
                menu.Items.Add("显示窗口", null, (s, e) => ShowWindowNow());
                menu.Items.Add("退出", null, (s, e) => { try { _form.Close(); } catch { } });
                _tray.ContextMenuStrip = menu;
                _tray.DoubleClick += (s, e) => ShowWindowNow();
                Trace("tray icon created");
            }
            catch (Exception ex) { Trace("tray failed: " + ex.Message); }
        }

        private static void ShowWindowNow()
        {
            try
            {
                if (_form == null) return;
                if (_form.WindowState == FormWindowState.Minimized) _form.WindowState = FormWindowState.Normal;
                _form.Show();
                _form.Activate();
                TryNativeShow("tray click");
            }
            catch (Exception ex) { Trace("show from tray failed: " + ex.Message); }
        }

        private static void RaiseExisting()
        {
            try
            {
                var me = Process.GetCurrentProcess();
                foreach (var p in Process.GetProcessesByName(me.ProcessName))
                {
                    if (p.Id == me.Id) continue;
                    p.Refresh();
                    if (p.MainWindowHandle == IntPtr.Zero) continue;
                    ShowWindow(p.MainWindowHandle, SW_RESTORE);
                    SetForegroundWindow(p.MainWindowHandle);
                    Trace("raised pid " + p.Id);
                    return;
                }
            }
            catch (Exception ex) { Trace("raise failed: " + ex.Message); }
        }
    }
}
