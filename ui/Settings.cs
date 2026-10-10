// Persisted UI settings. Kept as a tiny line-based file rather than JSON so it is
// readable and editable by hand, and so a corrupt file can never stop the app from
// starting (a damaged v2 settings.json was one cause of confusing failures).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
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

        /// <summary>
        /// Folders to search for games, several at a time. Results are merged into one
        /// list, so a library spread over multiple drives is still one window. Stored as a
        /// semicolon-separated list.
        /// </summary>
        public string ScanRootsRaw = "";

        /// <summary>
        /// How many folder levels below a scan root to look. 1 means the root's own
        /// children only.
        ///
        /// 4 is the default because it is where a scan stays quick: on the user's library a
        /// depth-4 walk visits 565 directories and finds 98 games, against 3228 directories
        /// and 136 games at depth 6. Raising it recovers games nested inside another game's
        /// folder (RJ-numbered releases often look like &lt;root&gt;\Title\Title\game) at
        /// the cost of a slower scan, hence a setting rather than a constant.
        /// </summary>
        public int ScanDepth = 4;

        /// <summary>Scan roots as a list, with duplicates and empties removed.</summary>
        public List<string> ScanRoots
        {
            get
            {
                var list = new List<string>();
                foreach (var part in (ScanRootsRaw ?? "").Split(';'))
                {
                    var p = part.Trim();
                    if (p.Length > 0 && !list.Any(x => string.Equals(x.TrimEnd('\\'), p.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)))
                        list.Add(p);
                }
                return list;
            }
            set { ScanRootsRaw = string.Join(";", value); }
        }

        public void AddScanRoot(string path)
        {
            if (string.IsNullOrEmpty(path)) return;
            var list = ScanRoots;
            if (list.Any(p => string.Equals(p.TrimEnd('\\'), path.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))) return;
            list.Add(path);
            ScanRoots = list;
        }

        public void RemoveScanRoot(string path)
        {
            ScanRoots = ScanRoots.Where(p => !string.Equals(p, path, StringComparison.OrdinalIgnoreCase)).ToList();
        }

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
                        case "ScanRoots": s.ScanRootsRaw = val; break;
                        case "ScanDepth": if (int.TryParse(val, out n) && n >= 1 && n <= 12) s.ScanDepth = n; break;
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
                sb.AppendLine("ScanRoots=" + ScanRootsRaw);
                sb.AppendLine("ScanDepth=" + ScanDepth.ToString(CultureInfo.InvariantCulture));
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
