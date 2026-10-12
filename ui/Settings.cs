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
        /// <summary>Where the .gguf files live. The shipped default is the one the manual documents;
        /// a new install is expected to point this at its own model folder.</summary>
        public string ModelDir = @"D:\galtrans";

        /// <summary>
        /// Translate through a hosted OpenAI-compatible endpoint instead of a local llama-server.
        ///
        /// Why: a hosted key often carries free quota on several models (measured: an Alibaba Model
        /// Studio key offers an independent quota per model), which is cheaper and faster than a local
        /// GPU for a big library — and for languages the local models handle badly.
        ///
        /// The endpoint and the model name live here, in a file the user can read and edit; the KEY does
        /// not — it is read from api-config.json (gitignored) or the GT_API_KEY environment variable, so
        /// no credential is ever part of the source, an example or a test.
        /// </summary>
        public bool UseApi = false;
        public string ApiBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";
        public string ApiModel = "qwen-mt-plus";

        /// <summary>
        /// The fallback chain, comma separated, first one tried first.
        ///
        /// A hosted key usually carries an independent free quota per model, and a spent one answers
        /// 403 AllocationQuota.FreeTierOnly. When that happens the pipeline moves to the next name here
        /// and asks again for the SAME line — so the batch loses nothing, and the run does not start
        /// reporting failures just because one model's free tier ran out.
        /// </summary>
        public string ApiModels = "qwen-mt-plus,qwen-mt-turbo,qwen-plus,qwen-turbo,qwen-max";
        public string Model = "Galtransl-v4-4B-2601.gguf";
        public string WorkDir = "";
        public string PromptFile = "";
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
        /// Folder holding llama-server.exe.
        ///
        /// Not derived from the install root alone: v3 is deployed separately from the
        /// working v2 install, and the runtimes (llama, node, ruby) legitimately stay in
        /// one place while the UI moves. Defaulting to the old location when the program's
        /// own folder has no copy avoids a "llama-server.exe not found" on a fresh deploy.
        /// </summary>
        public string LlamaDir = "";

        /// <summary>The llama folder beside this install. Nothing points at another install.</summary>
        public static string DefaultLlamaDir(string root)
        {
            return Path.Combine(root, "llama");
        }

        /// <summary>The work folder beside this install.</summary>
        public static string DefaultWorkDir(string root)
        {
            return Path.Combine(root, "work");
        }

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

        /// <summary>Where the API key is kept: a file beside the settings, never inside them.</summary>
        public static string ApiConfigPath(string root) { return Path.Combine(root, "api-config.json"); }

        /// <summary>
        /// The API key, from the environment first and from api-config.json second.
        ///
        /// The environment wins so a scripted or portable install can pass it without leaving it on disk;
        /// GT_API_KEY is also the name the pipeline's client reads, so one variable configures both.
        /// </summary>
        public static string LoadApiKey(string root)
        {
            var env = Environment.GetEnvironmentVariable("GT_API_KEY");
            if (!string.IsNullOrEmpty(env)) return env.Trim();
            try
            {
                string path = ApiConfigPath(root);
                if (!File.Exists(path)) return "";
                var text = File.ReadAllText(path, Encoding.UTF8);
                // Written by SaveApiKey below, so the shape is known: one "apiKey" string. A key is
                // sk-... shaped (letters, digits, dots, dashes), so the simple quoted match is enough.
                var m = System.Text.RegularExpressions.Regex.Match(text, "\"apiKey\"\\s*:\\s*\"([^\"]*)\"");
                return m.Success ? m.Groups[1].Value.Trim() : "";
            }
            catch { return ""; }
        }

        /// <summary>Persist the key. Returns false when the file could not be written.</summary>
        public static bool SaveApiKey(string root, string key)
        {
            try
            {
                var sb = new StringBuilder();
                sb.Append("{\n  \"apiKey\": \"").Append(JsonEscape(key ?? "")).Append("\"\n}\n");
                File.WriteAllText(ApiConfigPath(root), sb.ToString(), new UTF8Encoding(false));
                return true;
            }
            catch { return false; }
        }

        private static string JsonEscape(string s)
        {
            var sb = new StringBuilder(s.Length + 8);
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default: sb.Append(c); break;
                }
            }
            return sb.ToString();
        }

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
            s.LlamaDir = DefaultLlamaDir(root);
            if (!string.IsNullOrEmpty(root))
            {
                s.WorkDir = DefaultWorkDir(root);
                s.PromptFile = Path.Combine(s.WorkDir, "prompt.txt");
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
                        case "UseApi": s.UseApi = val == "1" || val.Equals("true", StringComparison.OrdinalIgnoreCase); break;
                        case "ApiBaseUrl": if (val.Length > 0) s.ApiBaseUrl = val; break;
                        case "ApiModel": if (val.Length > 0) s.ApiModel = val; break;
                        case "ApiModels": if (val.Length > 0) s.ApiModels = val; break;
                        case "WorkDir": s.WorkDir = val; break;
                        case "PromptFile": s.PromptFile = val; break;
                        case "Port": if (int.TryParse(val, out n) && n > 0 && n < 65536) s.Port = n; break;
                        case "PipelineJs": if (val.Length > 0) s.PipelineJs = val; break;
                        case "LlamaDir": if (val.Length > 0) s.LlamaDir = val; break;
                        case "ScanRoots": s.ScanRootsRaw = val; break;
                        case "ScanDepth": if (int.TryParse(val, out n) && n >= 1 && n <= 12) s.ScanDepth = n; break;
                        case "MaxAttempts": if (int.TryParse(val, out n) && n >= 1 && n <= 10) s.MaxAttempts = n; break;
                        case "GameBudgetMinutes": if (int.TryParse(val, out n) && n >= 5) s.GameBudgetMinutes = n; break;
                        case "StalledAfterMinutes": if (int.TryParse(val, out n) && n >= 1) s.StalledAfterMinutes = n; break;
                    }
                }
                // A local .gguf name can end up in ApiModel: it is what the dropdown held when cloud mode
                // was switched on. A hosted endpoint does not know that name, so every request would come
                // back "model not found". Fall back to the first entry of the chain instead.
                if (s.ApiModel.EndsWith(".gguf", StringComparison.OrdinalIgnoreCase))
                {
                    var first = s.ApiModels.Split(',').Select((x) => x.Trim()).FirstOrDefault((x) => x.Length > 0);
                    s.ApiModel = !string.IsNullOrEmpty(first) ? first : "qwen-mt-plus";
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
                sb.AppendLine("UseApi=" + (UseApi ? "1" : "0"));
                sb.AppendLine("ApiBaseUrl=" + ApiBaseUrl);
                sb.AppendLine("ApiModel=" + ApiModel);
                sb.AppendLine("ApiModels=" + ApiModels);
                sb.AppendLine("WorkDir=" + WorkDir);
                sb.AppendLine("PromptFile=" + PromptFile);
                sb.AppendLine("PipelineJs=" + PipelineJs);
                sb.AppendLine("LlamaDir=" + LlamaDir);
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
