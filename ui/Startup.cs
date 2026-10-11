// The launch trace, shared by the launcher and the form so one log covers a whole start.
//
// It carries a stopwatch reading beside the wall clock: the symptom this exists to catch is a delay
// measured in tens of seconds between two lines, and a clock alone makes the reader subtract
// timestamps by hand. That is how the 34-second start was found — the gap sat between
// "MainForm constructed" and "窗口已显示", inside the show path, because the game list was being
// pushed into a real (non-virtual) ListView during the first display.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace GameTranslatorV3
{
    internal static class Startup
    {
        private static readonly Stopwatch Sw = Stopwatch.StartNew();
        private static string _file = "";

        public static void Init(string root)
        {
            try { Directory.CreateDirectory(Path.Combine(root, "work")); } catch { }
            _file = Path.Combine(root, "work", "startup-trace.log");
        }

        public static void Trace(string s)
        {
            if (_file.Length == 0) return;
            try
            {
                File.AppendAllText(_file,
                    DateTime.Now.ToString("HH:mm:ss.fff") + "  pid=" +
                    Process.GetCurrentProcess().Id + "  +" +
                    Sw.ElapsedMilliseconds.ToString().PadLeft(6) + "ms  " + s + Environment.NewLine,
                    Encoding.UTF8);
            }
            catch { }
        }
    }
}
