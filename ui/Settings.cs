// Persisted UI settings. Kept as a tiny line-based file rather than JSON so it is
// readable and editable by hand, and so a corrupt file can never stop the app from
// starting (a damaged v2 settings.json was one cause of confusing failures).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace GameTranslatorV3.Core
{
    public sealed class Settings
    {
        public string ModelDir = @"H:\model";
        public string Model = "Galtransl-v4-4B-2601.gguf";
        public string WorkDir = @"D:\GameTranslator\work";
        public string PromptFile = @"D:\GameTranslator\work\prompt.txt";
        public int Port = 18080;

        /// <summary>Attempts per game before it is skipped and the batch continues.</summary>
        public int MaxAttempts = 3;

        /// <summary>Total time allowed for one game; exceeded means kill and retry.</summary>
        public int GameBudgetMinutes = 180;

        /// <summary>No pipeline output for this long means it is stuck: kill and retry.</summary>
        public int StalledAfterMinutes = 10;

        private static string FilePath(string root) { return Path.Combine(root, "ui-settings.ini"); }

        public static Settings Load(string root)
        {
            var s = new Settings();
            if (!string.IsNullOrEmpty(root))
            {
                string work = Path.Combine(root, "work");
                if (Directory.Exists(work)) s.WorkDir = work;
                string prompt = Path.Combine(work, "prompt.txt");
                s.PromptFile = prompt;
            }
            try
            {
                string path = FilePath(root);
                if (!File.Exists(path)) return s;
                foreach (var raw in File.ReadAllLines(path, Encoding.UTF8))
                {
                    var line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith("#") || line.StartsWith(";")) continue;
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    string key = line.Substring(0, eq).Trim();
                    string val = line.Substring(eq + 1).Trim();
                    int n;
                    switch (key)
                    {
                        case "ModelDir": s.ModelDir = val; break;
                        case "Model": s.Model = val; break;
                        case "WorkDir": s.WorkDir = val; break;
                        case "PromptFile": s.PromptFile = val; break;
                        case "Port": if (int.TryParse(val, out n) && n > 0 && n < 65536) s.Port = n; break;
                        case "MaxAttempts": if (int.TryParse(val, out n) && n >= 1 && n <= 10) s.MaxAttempts = n; break;
                        case "GameBudgetMinutes": if (int.TryParse(val, out n) && n >= 5) s.GameBudgetMinutes = n; break;
                        case "StalledAfterMinutes": if (int.TryParse(val, out n) && n >= 1) s.StalledAfterMinutes = n; break;
                    }
                }
            }
            catch { /* defaults are always usable */ }
            return s;
        }

        public void Save(string root)
        {
            try
            {
                var sb = new StringBuilder();
                sb.AppendLine("# GameTranslator v3 设置");
                sb.AppendLine("ModelDir=" + ModelDir);
                sb.AppendLine("Model=" + Model);
                sb.AppendLine("WorkDir=" + WorkDir);
                sb.AppendLine("PromptFile=" + PromptFile);
                sb.AppendLine("Port=" + Port.ToString(CultureInfo.InvariantCulture));
                sb.AppendLine("MaxAttempts=" + MaxAttempts.ToString(CultureInfo.InvariantCulture));
                sb.AppendLine("GameBudgetMinutes=" + GameBudgetMinutes.ToString(CultureInfo.InvariantCulture));
                sb.AppendLine("StalledAfterMinutes=" + StalledAfterMinutes.ToString(CultureInfo.InvariantCulture));
                File.WriteAllText(FilePath(root), sb.ToString(), Encoding.UTF8);
            }
            catch { }
        }
    }
}
