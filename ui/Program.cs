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
        private static string _traceFile = "";
        private static NotifyIcon _tray;
        private static MainForm _form;

        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
        private const int SW_SHOWNORMAL = 1, SW_SHOW = 5, SW_RESTORE = 9;

        private static void Trace(string s)
        {
            try
            {
                File.AppendAllText(_traceFile,
                    DateTime.Now.ToString("HH:mm:ss.fff") + "  pid=" +
                    Process.GetCurrentProcess().Id + "  " + s + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
        }

        [STAThread]
        private static void Main()
        {
            _root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            try { Directory.CreateDirectory(Path.Combine(_root, "work")); } catch { }
            _traceFile = Path.Combine(_root, "work", "startup-trace.log");
            Trace("launcher start");

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // One window only. A second launch raises the running one rather than opening a
            // second copy at the same place, which looked like the app doing nothing.
            bool owned;
            using (var single = new Mutex(true, @"Local\GameTranslatorV3_SingleInstance", out owned))
            {
                if (!owned) { Trace("already running; raising it and exiting"); RaiseExisting(); return; }

                Application.ThreadException += (s, e) => Trace("THREAD EXCEPTION: " + e.Exception);
                AppDomain.CurrentDomain.UnhandledException += (s, e) => Trace("UNHANDLED: " + e.ExceptionObject);

                try
                {
                    Trace("constructing MainForm");
                    _form = new MainForm(_root);
                    Trace("constructed; handle=" + _form.Handle + " visible=" + _form.Visible);

                    SetupTray();
                    StartShowRetries();

                    // Show by handle BEFORE the loop: the in-process Show() path does not take
                    // effect here, but the native call does.
                    TryNativeShow("before run");
                    Trace("entering message loop");
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

        /// <summary>
        /// Keep trying to show the window during the first seconds. The first attempt can
        /// land before the window is ready, and the loop is not dispatching, so a timer is
        /// not an option — a background thread schedules the attempts instead.
        /// </summary>
        private static void StartShowRetries()
        {
            var th = new Thread(() =>
            {
                foreach (var delay in new[] { 300, 800, 1500, 3000, 6000 })
                {
                    Thread.Sleep(delay);
                    try
                    {
                        if (!_form.IsHandleCreated) continue;
                        var h = _form.Handle;
                        if (IsWindowVisible(h)) { Trace("shown after " + delay + "ms"); return; }
                        ShowWindow(h, SW_SHOW);
                        SetForegroundWindow(h);
                        Trace("retry at " + delay + "ms: visible=" + IsWindowVisible(h));
                        if (IsWindowVisible(h)) return;
                    }
                    catch (Exception ex) { Trace("retry failed: " + ex.Message); }
                }
            });
            th.IsBackground = true;
            th.Start();
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
