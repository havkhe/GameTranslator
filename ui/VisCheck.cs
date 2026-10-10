// Why does the form never become visible?
//
// From outside, IsWindowVisible(hwnd) is False even though Application.Run(form) was
// entered and the form has a title, size and position. This asks the FORM itself, which
// is the only place that can tell whether Visible/Show() had any effect, and it forces
// Show() explicitly to see whether that sticks.
using System;
using System.Windows.Forms;

namespace GameTranslatorV3.VisCheck
{
    internal static class Program
    {
        private static void Say(string s)
        {
            Console.WriteLine(s);
            try
            {
                System.IO.File.AppendAllText(
                    System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "work", "vischeck.log"),
                    DateTime.Now.ToString("HH:mm:ss.fff") + "  " + s + Environment.NewLine);
            }
            catch { }
        }

        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            var root = AppDomain.CurrentDomain.BaseDirectory;
            Say("before construct");
            MainForm form = null;
            try { form = new MainForm(root); }
            catch (Exception ex) { Say("construct threw: " + ex); return; }
            Say("after construct: Visible=" + form.Visible + " Handle=" + form.Handle
                + " WindowState=" + form.WindowState + " TopMost=" + form.TopMost
                + " ShowInTaskbar=" + form.ShowInTaskbar + " Opacity=" + form.Opacity);

            // Application.Run does Show() internally; replicate it step by step so the effect
            // of each call is visible.
            var t = new Timer { Interval = 1500 };
            int step = 0;
            t.Tick += (s, e) =>
            {
                try
                {
                    switch (step)
                    {
                        case 0:
                            Say("step0: Visible=" + form.Visible + " IsHandleCreated=" + form.IsHandleCreated);
                            break;
                        case 1:
                            form.Show();
                            Say("step1 after Show(): Visible=" + form.Visible);
                            break;
                        case 2:
                            form.TopMost = true; form.TopMost = false;
                            form.Activate(); form.BringToFront();
                            Say("step2 after raise: Visible=" + form.Visible);
                            break;
                        default:
                            Say("final: Visible=" + form.Visible + " WindowState=" + form.WindowState);
                            t.Stop();
                            form.Close();
                            Application.Exit();
                            break;
                    }
                    step++;
                }
                catch (Exception ex) { Say("step threw: " + ex.Message); }
            };

            var q = new Timer { Interval = 200 };
            q.Tick += (s, e) => { q.Stop(); t.Start(); };
            Say("about to call Application.Run");
            // Show it ourselves first, then run the loop: this separates "the loop never
            // showed it" from "showing it does not work".
            form.Show();
            Say("after explicit Show() before Run: Visible=" + form.Visible);
            q.Start();
            Application.Run(form);
            Say("message loop exited");
        }
    }
}
