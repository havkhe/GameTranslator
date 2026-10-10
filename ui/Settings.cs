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

        /// <summary>
        /// The pipeline script to run. v3 lives in pipeline\index.js; the v2 script
        /// (game-pipeline.js) is still accepted so an existing install keeps working,
        /// and the runner falls back to whichever exists.
        /// </summary>
        public string PipelineJs = "";

        private static string FilePath(string root) { return Path.Combine(root, "ui-settings.ini"); }

        /// <summary>Best guess for the pipeline script under a given install root.</summary>
        public static string DefaultPipeline(string root)
        {
            string v3 = Path.Combine(root, "pipeline", "index.js");
            if (File.Exists(v3)) return v3;
            string v2 = Path.Combine(root, "game-pipeline.js");
            if (File.Exists(v2)) return v2;
            return v3;
        }

        public static Settings Load(string root)
        {
            var s = new Settings();
            s.PipelineJs = DefaultPipeline(root);
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
                        case "PipelineJs": if (val.Length > 0) s.PipelineJs = val; break;
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
                sb.AppendLine("PipelineJs=" + PipelineJs);
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
