using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Management;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace GameTranslator
{
    public class GameItem
    {
        public string Dir;
        public string Kind = "MV";
        public string Status = "待汉化";
        public bool AlreadyCn;
        public long DataBytes;
        // Where the engine data lives and how the game is laid out; both are
        // needed to back up / restore the right folder.
        public string DataDir;       // absolute path of the json data folder
        public bool RootLayout;      // true when data/ sits next to Game.exe (no www/)
    }

    [DataContract]
    public class Settings
    {
        public const string DefaultPrompt =
            "将下列每行日文翻译成简体中文。禁止翻译成英文，只输出简体中文。\r\n" +
            "必须原样保留 \\N[1]、\\V[1]、\\N<角色名> 等控制代码；行数必须与输入完全相同。\r\n" +
            "每行输出一条译文，不要编号、不要JSON、不要解释。\r\n" +
            "{lines}";

        [DataMember] public string ModelDir = "D:\\galtrans";
        [DataMember] public string LlamaDir = "D:\\GameTranslator\\llama";
        [DataMember] public string Device = "gpu";
        [DataMember] public int MaxMemoryMB = 0;
        [DataMember] public string ScanPath = "K:\\";
        [DataMember] public int Port = 18080;
        [DataMember] public int LlamaContext = 4096;
        [DataMember] public int LlamaGpuLayers = 99;
        [DataMember] public int LlamaBatch = 512;
        [DataMember] public int LlamaUbatch = 256;
        [DataMember] public int LlamaThreads = 0;
        [DataMember] public int LlamaPoll = 0;
        [DataMember] public string LlamaFlashAttn = "auto";
        [DataMember] public string LlamaCacheK = "f16";
        [DataMember] public string LlamaCacheV = "f16";
        // llama.cpp 默认 4 个 slot；本工具是单请求串行，多余 slot 在 6GB 卡上
        // 互相争抢，实测解码速度差一倍（23 → 37 tok/s）。
        [DataMember] public int LlamaParallel = 1;
        [DataMember] public string Prompt = DefaultPrompt;
        [DataMember] public string LlamaPreset = "auto";
    }

    [DataContract]
    public class BadItem
    {
        [DataMember] public int id;
        [DataMember] public string text;
        [DataMember] public string trans;
        [DataMember] public string reason;
    }

    [DataContract]
    public class UntranslatedResult
    {
        // v2.4: tiered output. `fatal` = must not be kept (control codes lost,
        // repetition loop, truncation, wrong script); `suspect` = style issues
        // worth reviewing; `pending` = never translated. `bad` is kept as the
        // union of fatal+suspect so older builds still read the file.
        [DataMember] public BadItem[] fatal;
        [DataMember] public BadItem[] suspect;
        [DataMember] public BadItem[] bad;
        [DataMember] public BadItem[] pending;
    }

    public class MainForm : Form
    {
        private ListView list;
        private Button btnScan, btnScanFolder, btnAdd, btnSelectAll, btnStartAll, btnRestore, btnRefresh,
            btnRefreshModels, btnModelDir, btnStart, btnPause, btnStop, btnCheck, btnRestoreCn, btnLlama,
            btnSettings, btnPromptSettings, btnToggleSide;
        private ComboBox cmbModel, cmbDevice;
        private TextBox txtScanPath;
        private ProgressBar progress;
        private Label lblStatus;
        private RichTextBox log;
        private Panel sidePanel;
        private SplitContainer mainSplit;
        private ToolStripMenuItem miPause;
        private List<GameItem> games = new List<GameItem>();
        private Dictionary<string, string> modelMap = new Dictionary<string, string>();
        private string appDir = AppDomain.CurrentDomain.BaseDirectory;
        private string nodePath = "";
        private bool busy;
        private bool paused;
        private Process llamaProcess;
        private IntPtr llamaJob = IntPtr.Zero;
        private long llamaMemLimitMB;
        private string currentModel = "";
        private string cpuName = "未知 CPU";
        private string gpuName = "未知 GPU";
        private Settings settings = new Settings();

        public MainForm()
        {
            Text = "RPG Maker 汉化管理器 v2.4";
            Width = 1720;
            Height = 760;
            MinimumSize = new Size(1280, 640);
            StartPosition = FormStartPosition.CenterScreen;
            AllowDrop = true;
            DragEnter += (s, e) => { if (e.Data.GetDataPresent(DataFormats.FileDrop)) e.Effect = DragDropEffects.Copy; };
            DragDrop += OnDrop;
            FormClosed += (s, e) => KillLlama();
            LoadSettings();
            llamaMemLimitMB = settings.MaxMemoryMB > 0 ? settings.MaxMemoryMB : AutoMemLimitMB();
            BuildUi();
            ResolveNode();
            LoadModels();
            LoadGamesCache();
            SetLlamaStatus("未启动");
            Log("llama 内存上限: " + llamaMemLimitMB + " MB（可在 settings.json 的 MaxMemoryMB 调整，0=自动）");
        }

        private void BuildUi()
        {
            // ---------------- menu ----------------
            var menu = new MenuStrip();
            var mFile = new ToolStripMenuItem("文件(&F)");
            mFile.DropDownItems.Add("添加游戏(Game.exe)…", null, (s, e) => AddGame());
            mFile.DropDownItems.Add("选择扫描文件夹…", null, (s, e) => ChooseScanFolder());
            mFile.DropDownItems.Add("扫描当前路径", null, (s, e) => { var p = txtScanPath.Text.Trim(); if (p != "") ScanRoot(p); });
            mFile.DropDownItems.Add("刷新状态", null, (s, e) => RefreshStatus());
            mFile.DropDownItems.Add(new ToolStripSeparator());
            mFile.DropDownItems.Add("退出", null, (s, e) => Close());
            var mTrans = new ToolStripMenuItem("翻译(&T)");
            mTrans.DropDownItems.Add("开始汉化选中", null, (s, e) => StartTranslate(false));
            mTrans.DropDownItems.Add("全部汉化", null, (s, e) => StartTranslate(true));
            miPause = new ToolStripMenuItem("暂停", null, (s, e) => TogglePause());
            mTrans.DropDownItems.Add(miPause);
            mTrans.DropDownItems.Add("终止", null, (s, e) => StopTranslate());
            mTrans.DropDownItems.Add(new ToolStripSeparator());
            mTrans.DropDownItems.Add("检查翻译", null, (s, e) => CheckTranslation());
            mTrans.DropDownItems.Add("卸载汉化(还原原版)", null, (s, e) => RestoreSelected());
            mTrans.DropDownItems.Add("恢复汉化(切回汉化版)", null, (s, e) => RestoreChinese());
            var mSet = new ToolStripMenuItem("设置(&S)");
            mSet.DropDownItems.Add("模型目录…", null, (s, e) => ChooseModelDir());
            mSet.DropDownItems.Add("刷新模型列表", null, (s, e) => LoadModels());
            mSet.DropDownItems.Add(new ToolStripSeparator());
            mSet.DropDownItems.Add("llama 高级设置…", null, (s, e) => OpenSettings(0));
            mSet.DropDownItems.Add("翻译提示词设置…", null, (s, e) => OpenSettings(1));
            mSet.DropDownItems.Add(new ToolStripSeparator());
            mSet.DropDownItems.Add("显示/隐藏设置面板", null, (s, e) => ToggleSidePanel());
            var mHelp = new ToolStripMenuItem("帮助(&H)");
            mHelp.DropDownItems.Add("使用说明", null, (s, e) => OpenHelp());
            mHelp.DropDownItems.Add("关于", null, (s, e) => MessageBox.Show("RPG Maker 汉化管理器 v2.4\n\n内置 llama.cpp 本地翻译引擎\n支持 MV / MZ / VX Ace\n支持自定义 llama 参数、RTX 预设与翻译提示词", "关于 GameTranslator"));
            menu.Items.AddRange(new ToolStripItem[] { mFile, mTrans, mSet, mHelp });
            MainMenuStrip = menu;

            // ---------------- top toolbar: row 1 (scan) ----------------
            var top = new Panel { Dock = DockStyle.Top, Height = 88 };
            txtScanPath = new TextBox { Location = new Point(10, 8), Width = 420, Text = settings.ScanPath };
            btnScanFolder = new Button { Text = "选择文件夹…", Width = 100, Location = new Point(438, 6) };
            btnScan = new Button { Text = "扫描", Width = 60, Location = new Point(544, 6) };
            btnAdd = new Button { Text = "添加游戏(选Game.exe)", Width = 160, Location = new Point(612, 6) };
            btnSelectAll = new Button { Text = "全选", Width = 60, Location = new Point(780, 6) };
            btnRefresh = new Button { Text = "刷新状态", Width = 90, Location = new Point(846, 6) };
            top.Controls.AddRange(new Control[] { txtScanPath, btnScanFolder, btnScan, btnAdd, btnSelectAll, btnRefresh });

            // ---------------- top toolbar: row 2 (model + actions) ----------------
            var lblModel = new Label { Text = "模型:", Location = new Point(10, 50), AutoSize = true };
            cmbModel = new ComboBox { Location = new Point(52, 46), Width = 260, DropDownStyle = ComboBoxStyle.DropDownList };
            cmbModel.SelectedIndexChanged += (s, e) =>
            {
                WarnIfModelTooSmall();
                if (llamaProcess != null && !llamaProcess.HasExited && cmbModel.SelectedItem != null)
                {
                    var m = (string)cmbModel.SelectedItem;
                    if (modelMap.ContainsKey(m) && modelMap[m] != currentModel)
                        Log("提示：模型已切换为 " + m + "；llama 不支持运行中热切换，将在下次开始汉化时自动重启并加载新模型。");
                }
            };
            btnRefreshModels = new Button { Text = "刷新模型", Width = 80, Location = new Point(318, 45) };
            btnModelDir = new Button { Text = "模型目录…", Width = 90, Location = new Point(404, 45) };
            btnStart = new Button { Text = "开始汉化选中", Width = 110, Location = new Point(510, 45), BackColor = Color.FromArgb(210, 235, 255) };
            btnStartAll = new Button { Text = "全部汉化", Width = 90, Location = new Point(626, 45), BackColor = Color.FromArgb(200, 255, 200) };
            btnPause = new Button { Text = "暂停", Width = 70, Location = new Point(722, 45) };
            btnStop = new Button { Text = "终止", Width = 70, Location = new Point(798, 45), BackColor = Color.FromArgb(255, 220, 220) };
            top.Controls.AddRange(new Control[] { lblModel, cmbModel, btnRefreshModels, btnModelDir, btnStart, btnStartAll, btnPause, btnStop });

            // ---------------- game list ----------------
            list = new ListView { Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, MultiSelect = true };
            list.Columns.Add("游戏目录", 700);
            list.Columns.Add("引擎", 70);
            list.Columns.Add("状态", 150);
            list.Columns.Add("数据大小", 90);

            // ---------------- right collapsible settings panel ----------------
            sidePanel = new Panel { Dock = DockStyle.Fill, Width = 260, BackColor = Color.FromArgb(246, 246, 250), Padding = new Padding(8) };
            var lblSideTitle = new Label { Text = "设置面板", Location = new Point(12, 8), Font = new Font(Font.FontFamily, 10f, FontStyle.Bold), AutoSize = true };
            var lblDev = new Label { Text = "运行设备", Location = new Point(12, 36), AutoSize = true };
            cmbDevice = new ComboBox { Location = new Point(12, 56), Width = 224, DropDownStyle = ComboBoxStyle.DropDownList };
            btnLlama = new Button { Text = "启动llama", Location = new Point(12, 86), Width = 224 };
            btnSettings = new Button { Text = "llama 高级设置…", Location = new Point(12, 118), Width = 224 };
            btnPromptSettings = new Button { Text = "翻译提示词设置…", Location = new Point(12, 150), Width = 224 };
            var lblSideCn = new Label { Text = "汉化维护", Location = new Point(12, 194), Font = new Font(Font.FontFamily, 10f, FontStyle.Bold), AutoSize = true };
            btnCheck = new Button { Text = "检查翻译", Location = new Point(12, 218), Width = 224 };
            btnRestore = new Button { Text = "卸载汉化(还原原版)", Location = new Point(12, 250), Width = 224 };
            btnRestoreCn = new Button { Text = "恢复汉化(切回汉化版)", Location = new Point(12, 282), Width = 224 };
            btnToggleSide = new Button { Text = "隐藏设置面板", Location = new Point(12, 324), Width = 224 };
            sidePanel.Controls.AddRange(new Control[] { lblSideTitle, lblDev, cmbDevice, btnLlama, btnSettings, btnPromptSettings, lblSideCn, btnCheck, btnRestore, btnRestoreCn, btnToggleSide });

            // ---------------- split: list | settings ----------------
            mainSplit = new SplitContainer { Dock = DockStyle.Fill, Orientation = Orientation.Vertical, SplitterWidth = 6, Panel2MinSize = 0 };
            mainSplit.Panel1.Controls.Add(list);
            mainSplit.Panel2.Controls.Add(sidePanel);

            // ---------------- bottom: log + progress + status ----------------
            var bottom = new Panel { Dock = DockStyle.Bottom, Height = 200 };
            progress = new ProgressBar { Dock = DockStyle.Top, Height = 18 };
            var statusBar = new Panel { Dock = DockStyle.Bottom, Height = 26 };
            lblStatus = new Label { Text = "就绪", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, ForeColor = Color.DarkBlue };
            statusBar.Controls.Add(lblStatus);
            log = new RichTextBox { Dock = DockStyle.Fill, ReadOnly = true, Font = new Font("Consolas", 9) };
            bottom.Controls.Add(log);
            bottom.Controls.Add(statusBar);
            bottom.Controls.Add(progress);

            Controls.Add(mainSplit);
            Controls.Add(bottom);
            Controls.Add(top);
            Controls.Add(menu);
            mainSplit.SplitterDistance = Math.Max(900, ClientSize.Width - 300);

            // ---------------- events ----------------
            btnScan.Click += (s, e) => { var p = txtScanPath.Text.Trim(); if (p != "") ScanRoot(p); };
            btnScanFolder.Click += (s, e) => ChooseScanFolder();
            btnAdd.Click += (s, e) => AddGame();
            btnSelectAll.Click += (s, e) => ToggleSelectAll();
            btnStartAll.Click += (s, e) => StartTranslate(true);
            btnRestore.Click += (s, e) => RestoreSelected();
            btnStart.Click += (s, e) => StartTranslate(false);
            btnRefresh.Click += (s, e) => RefreshStatus();
            btnRefreshModels.Click += (s, e) => LoadModels();
            btnModelDir.Click += (s, e) => ChooseModelDir();
            btnPause.Click += (s, e) => TogglePause();
            btnStop.Click += (s, e) => StopTranslate();
            btnCheck.Click += (s, e) => CheckTranslation();
            btnRestoreCn.Click += (s, e) => RestoreChinese();
            btnLlama.Click += (s, e) => ToggleLlama();
            btnSettings.Click += (s, e) => OpenSettings(0);
            btnPromptSettings.Click += (s, e) => OpenSettings(1);
            btnToggleSide.Click += (s, e) => ToggleSidePanel();
            DetectHardware();
            ApplyOptimalDefaults();

            var ctx = new ContextMenuStrip();
            ctx.Items.Add("启动游戏", null, (s, e) => LaunchSelected());
            ctx.Items.Add("在资源管理器中打开目录", null, (s, e) => OpenInExplorer());
            ctx.Items.Add(new ToolStripSeparator());
            ctx.Items.Add("检查翻译", null, (s, e) => CheckTranslation());
            ctx.Items.Add("恢复汉化", null, (s, e) => RestoreChinese());
            ctx.Items.Add("刷新状态", null, (s, e) => RefreshStatus());
            ctx.Items.Add("一键还原选中", null, (s, e) => RestoreSelected());
            list.ContextMenuStrip = ctx;
        }

        private void ToggleSidePanel()
        {
            if (mainSplit == null) return;
            mainSplit.Panel2Collapsed = !mainSplit.Panel2Collapsed;
            btnToggleSide.Text = mainSplit.Panel2Collapsed ? "显示设置面板" : "隐藏设置面板";
            Log(mainSplit.Panel2Collapsed ? "设置面板已隐藏（仍可从菜单 设置→llama 高级设置 使用）" : "设置面板已显示");
        }

        private void OpenHelp()
        {
            var p = Path.Combine(appDir, "使用说明.txt");
            if (!File.Exists(p)) { MessageBox.Show("未找到使用说明.txt"); return; }
            try { Process.Start(new ProcessStartInfo(p) { UseShellExecute = true }); }
            catch (Exception ex) { Log("打开使用说明失败: " + ex.Message); }
        }

        private void OpenSettings(int tab)
        {
            var f = new SettingsForm(settings, tab);
            // 只有点击“保存”才会应用修改；“取消”直接丢弃。
            if (f.ShowDialog(this) != DialogResult.OK) return;
            settings = f.Result;
            NormalizeSettings();
            SaveSettings();
            llamaMemLimitMB = settings.MaxMemoryMB > 0 ? settings.MaxMemoryMB : AutoMemLimitMB();
            var preview = BuildLlamaArgs(Path.Combine(settings.ModelDir, "model.gguf"));
            Log("llama 设置已保存，当前参数: " + preview);
            string note;
            if (llamaProcess != null && !llamaProcess.HasExited)
            {
                KillLlama();
                note = "llama 已停止，将在下次启动/汉化时应用新参数。";
            }
            else note = "llama 未运行，将在启动时应用新参数。";
            MessageBox.Show("设置已保存，点击“保存”后才会生效。\n\n当前 llama 参数：\n" + preview + "\n\n" + note, "GameTranslator");
        }

        // ---------------- settings ----------------
        private string SettingsPath()
        {
            var p = Path.Combine(appDir, "settings.json");
            if (File.Exists(p)) return p;
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "GameTranslator", "settings.json");
        }

        private void LoadSettings()
        {
            try
            {
                var p = SettingsPath();
                if (!File.Exists(p)) return;
                var ser = new DataContractJsonSerializer(typeof(Settings));
                using (var fs = File.OpenRead(p)) settings = (Settings)ser.ReadObject(fs);
                if (settings == null) settings = new Settings();
            }
            catch { settings = new Settings(); }
            NormalizeSettings();
        }

        private void NormalizeSettings()
        {
            if (string.IsNullOrEmpty(settings.ModelDir)) settings.ModelDir = "D:\\galtrans";
            if (string.IsNullOrEmpty(settings.LlamaDir)) settings.LlamaDir = "D:\\GameTranslator\\llama";
            if (string.IsNullOrEmpty(settings.Device)) settings.Device = "gpu";
            if (string.IsNullOrEmpty(settings.ScanPath)) settings.ScanPath = "K:\\";
            if (settings.Port < 1024 || settings.Port > 65535) settings.Port = 18080;
            if (settings.LlamaContext < 512 || settings.LlamaContext > 65536) settings.LlamaContext = 4096;
            if (settings.LlamaGpuLayers < 0 || settings.LlamaGpuLayers > 999) settings.LlamaGpuLayers = 99;
            if (settings.LlamaBatch < 32 || settings.LlamaBatch > 8192) settings.LlamaBatch = 512;
            if (settings.LlamaUbatch < 16 || settings.LlamaUbatch > 4096) settings.LlamaUbatch = 256;
            if (settings.LlamaThreads < 0 || settings.LlamaThreads > 256) settings.LlamaThreads = 0;
            if (settings.LlamaPoll < 0 || settings.LlamaPoll > 100) settings.LlamaPoll = 0;
            if (string.IsNullOrEmpty(settings.LlamaFlashAttn)) settings.LlamaFlashAttn = "auto";
            if (string.IsNullOrEmpty(settings.LlamaCacheK)) settings.LlamaCacheK = "f16";
            if (string.IsNullOrEmpty(settings.LlamaCacheV)) settings.LlamaCacheV = "f16";
            if (settings.LlamaParallel < 1 || settings.LlamaParallel > 8) settings.LlamaParallel = 1;
            if (string.IsNullOrWhiteSpace(settings.Prompt)) settings.Prompt = Settings.DefaultPrompt;
            else if (IsLegacyPrompt(settings.Prompt))
            {
                // v2.3.x shipped a prompt that asked for a JSON object; the models
                // are fine-tuned for one line in / one line out, so upgrade a
                // saved *stock* prompt (a hand-edited one is left alone).
                Log("翻译提示词已升级为 v2.4 默认逐行格式（原为 v2.3 的 JSON 格式；可在“翻译提示词设置”中改回或自定义）");
                settings.Prompt = Settings.DefaultPrompt;
                promptMigrated = true;
            }
            if (string.IsNullOrEmpty(settings.LlamaPreset)) settings.LlamaPreset = "auto";
            if (promptMigrated) SaveSettings();
        }

        private bool promptMigrated;

        // True when the saved prompt is the stock v2.3 JSON prompt (including the
        // CRLF variant DataContract may have produced).
        private static bool IsLegacyPrompt(string p)
        {
            if (string.IsNullOrEmpty(p)) return false;
            return p.IndexOf("只输出一个JSON对象", StringComparison.Ordinal) >= 0
                && p.IndexOf("{lines}", StringComparison.Ordinal) >= 0;
        }

        private void SaveSettings()
        {
            try
            {
                var p = SettingsPath();
                var dir = Path.GetDirectoryName(p);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                var ser = new DataContractJsonSerializer(typeof(Settings));
                using (var fs = File.Create(p)) ser.WriteObject(fs, settings);
            }
            catch (Exception ex)
            {
                Log("保存设置失败: " + ex.Message);
                MessageBox.Show("保存设置失败：" + ex.Message + "\n\n请确认程序目录可写（例如不要放在 Program Files 或只读目录）。",
                    "GameTranslator");
            }
        }

        // ---------------- presets / auto-optimize ----------------
        private bool LlamaFieldsAreDefaults()
        {
            return settings.LlamaContext == 4096 && settings.LlamaGpuLayers == 99 &&
                   settings.LlamaBatch == 512 && settings.LlamaUbatch == 256 &&
                   settings.LlamaThreads == 0 && settings.LlamaPoll == 0 &&
                   (settings.LlamaFlashAttn ?? "auto") == "auto" &&
                   (settings.LlamaCacheK ?? "f16") == "f16" &&
                   (settings.LlamaCacheV ?? "f16") == "f16";
        }

        private void ApplyOptimalDefaults()
        {
            if (settings.LlamaPreset != "auto") return;
            bool rtx = gpuName.IndexOf("RTX", StringComparison.OrdinalIgnoreCase) >= 0;
            if (!rtx || !LlamaFieldsAreDefaults()) return;
            ApplyPreset("rtx");
            settings.LlamaPreset = "rtx";
            SaveSettings();
            Log("检测到 RTX 显卡，已自动应用 RTX 优化参数（FlashAttention + f16 KV + 单 slot + 2048/512 批次），可在 设置 → llama 高级设置 修改");
        }

        private void ApplyPreset(string preset)
        {
            if (preset == "rtx")
            {
                settings.LlamaContext = 4096;
                settings.LlamaGpuLayers = 99;
                settings.LlamaBatch = 2048;
                settings.LlamaUbatch = 512;
                settings.LlamaThreads = 4;
                settings.LlamaPoll = 0;
                settings.LlamaFlashAttn = "on";
                // 实测：量化 KV cache 在 1060 上把解码从 ~37 tok/s 拖到 ~23 tok/s
                // （每步都要反量化）。4B Q4 模型 + 4K 上下文的 f16 KV 只占约
                // 0.5GB，6GB 卡放得下，不值得为省显存牺牲一半速度。
                settings.LlamaCacheK = "f16";
                settings.LlamaCacheV = "f16";
                settings.LlamaParallel = 1;
            }
            else if (preset == "vram")
            {
                settings.LlamaContext = 4096;
                settings.LlamaGpuLayers = 99;
                settings.LlamaBatch = 256;
                settings.LlamaUbatch = 128;
                settings.LlamaThreads = 2;
                settings.LlamaPoll = 0;
                settings.LlamaFlashAttn = "on";
                settings.LlamaCacheK = "q8_0";
                settings.LlamaCacheV = "q8_0";
                settings.LlamaParallel = 1;
            }
            else
            {
                settings.LlamaContext = 4096;
                settings.LlamaGpuLayers = 99;
                settings.LlamaBatch = 512;
                settings.LlamaUbatch = 256;
                settings.LlamaThreads = 0;
                settings.LlamaPoll = 0;
                settings.LlamaFlashAttn = "auto";
                settings.LlamaCacheK = "f16";
                settings.LlamaCacheV = "f16";
            }
        }

        // ---------------- llama management ----------------
        private void DetectHardware()
        {
            try
            {
                var mo = new ManagementObjectSearcher("SELECT Name FROM Win32_Processor");
                foreach (ManagementObject o in mo.Get()) { cpuName = Convert.ToString(o["Name"]); break; }
            }
            catch { }
            try
            {
                var psi = new ProcessStartInfo("nvidia-smi", "--query-gpu=name --format=csv,noheader") { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true };
                using (var p = Process.Start(psi))
                {
                    p.WaitForExit(5000);
                    var line = p.StandardOutput.ReadToEnd().Trim();
                    if (!string.IsNullOrEmpty(line)) gpuName = line.Split('\n')[0].Trim();
                }
            }
            catch { }
            if (gpuName == "未知 GPU")
            {
                try
                {
                    var mo = new ManagementObjectSearcher("SELECT Name FROM Win32_VideoController");
                    foreach (ManagementObject o in mo.Get()) { var n = Convert.ToString(o["Name"]); if (!string.IsNullOrEmpty(n)) { gpuName = n; break; } }
                }
                catch { }
            }
            cmbDevice.Items.Add("GPU (" + gpuName + ")");
            cmbDevice.Items.Add("CPU (" + cpuName + ")");
            cmbDevice.SelectedIndex = settings.Device == "cpu" ? 1 : 0;
        }

        private long AutoMemLimitMB()
        {
            long totalMB = 8192;
            try
            {
                var mo = new ManagementObjectSearcher("SELECT TotalPhysicalMemory FROM Win32_ComputerSystem");
                foreach (ManagementObject o in mo.Get()) { totalMB = Convert.ToInt64(o["TotalPhysicalMemory"]) / (1024 * 1024); break; }
            }
            catch { }
            return Math.Max(4096, totalMB - 4096);
        }

        private void SetLlamaStatus(string s)
        {
            if (lblStatus == null) return;
            if (lblStatus.InvokeRequired) lblStatus.BeginInvoke(new Action(() => lblStatus.Text = s));
            else lblStatus.Text = s;
        }

        private void ToggleLlama()
        {
            if (llamaProcess != null && !llamaProcess.HasExited)
            {
                KillLlama();
                Log("llama 已停止（显存已释放）");
                return;
            }
            if (cmbModel.SelectedItem == null) { MessageBox.Show("没有可用模型"); return; }
            var modelPath = modelMap[(string)cmbModel.SelectedItem];
            if (EnsureLlama(modelPath)) Log("llama 已启动，模型已加载");
        }

        private bool EnsureLlama(string modelPath)
        {
            if (llamaProcess != null && !llamaProcess.HasExited && currentModel == modelPath)
            {
                SetLlamaStatus("就绪: " + Path.GetFileName(modelPath));
                return true;
            }
            KillLlama();
            var server = Path.Combine(appDir, "llama", "llama-server.exe");
            if (!File.Exists(server)) server = Path.Combine(settings.LlamaDir, "llama-server.exe");
            if (!File.Exists(server))
            {
                Log("未找到内置 llama-server（已尝试: " + Path.Combine(appDir, "llama") + " 与 " + settings.LlamaDir + "）。请确认 D:\\GameTranslator\\llama 存在，或修改 settings.json 的 LlamaDir。");
                return false;
            }
            Log("启动内置 llama（" + (settings.Device == "cpu" ? "CPU" : "GPU/CUDA") + "）：" + Path.GetFileName(modelPath));
            var psi = new ProcessStartInfo(server)
            {
                Arguments = BuildLlamaArgs(modelPath),
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            Log("llama 参数: " + psi.Arguments);
            try { llamaProcess = Process.Start(psi); }
            catch (Exception ex) { Log("启动 llama 失败: " + ex.Message); return false; }
            llamaJob = CreateJobObject(IntPtr.Zero, null);
            if (llamaJob != IntPtr.Zero)
            {
                var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.ProcessMemoryLimit = llamaMemLimitMB * 1024 * 1024;
                info.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY;
                if (SetInformationJobObject(llamaJob, 9, ref info, (uint)Marshal.SizeOf(info)))
                    AssignProcessToJobObject(llamaJob, llamaProcess.Handle);
                Log("llama 内存上限已生效: " + llamaMemLimitMB + " MB");
            }
            currentModel = modelPath;
            SetLlamaStatus("模型加载中…");
            var sw = Stopwatch.StartNew();
            while (sw.Elapsed < TimeSpan.FromSeconds(300))
            {
                if (llamaProcess.HasExited) { Log("llama-server 异常退出（代码 " + llamaProcess.ExitCode + "）"); KillLlama(); return false; }
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + settings.Port + "/health");
                    req.Timeout = 1500;
                    using (var r = (HttpWebResponse)req.GetResponse())
                        if ((int)r.StatusCode == 200)
                        {
                            SetLlamaStatus("就绪: " + Path.GetFileName(modelPath));
                            Log("llama 就绪");
                            if (btnLlama != null) btnLlama.Text = "停止llama";
                            return true;
                        }
                }
                catch { }
                Thread.Sleep(500);
            }
            Log("等待 llama 就绪超时（300秒）");
            return false;
        }

        private void KillLlama()
        {
            if (llamaProcess != null)
            {
                try { if (!llamaProcess.HasExited) { llamaProcess.Kill(); llamaProcess.WaitForExit(5000); } } catch { }
                try { llamaProcess.Dispose(); } catch { }
                llamaProcess = null;
            }
            if (llamaJob != IntPtr.Zero) { try { CloseHandle(llamaJob); } catch { } llamaJob = IntPtr.Zero; }
            currentModel = "";
            SetLlamaStatus("未启动");
            if (btnLlama != null) btnLlama.Text = "启动llama";
        }

        private string BuildLlamaArgs(string modelPath)
        {
            int ngl = settings.Device == "cpu" ? 0 : settings.LlamaGpuLayers;
            // CUDA 后端下若让线程自动分配，所有 CPU 线程都会参与等待/搬运数据，
            // 表现为 CPU 占用暴增而 GPU 利用率不高；GPU 模式默认限制为 4 个线程，
            // 用户可在“设置 → llama 高级设置”中调整。
            int threads = settings.Device == "cpu"
                ? settings.LlamaThreads
                : (settings.LlamaThreads > 0 ? settings.LlamaThreads : 4);
            var sb = new StringBuilder();
            sb.Append("-m \"").Append(modelPath).Append("\" --host 127.0.0.1 --port ").Append(settings.Port)
              .Append(" -c ").Append(settings.LlamaContext)
              .Append(" -ngl ").Append(ngl)
              .Append(" -b ").Append(settings.LlamaBatch)
              .Append(" -ub ").Append(settings.LlamaUbatch);
            if (threads > 0) sb.Append(" -t ").Append(threads);
            // 默认 0：关闭 CPU 忙等轮询，显著降低 CUDA 推理时的 CPU 空转。
            sb.Append(" --poll ").Append(Math.Max(0, Math.Min(100, settings.LlamaPoll)));
            string fa = (settings.LlamaFlashAttn ?? "auto").ToLowerInvariant();
            if (fa == "on" || fa == "off") sb.Append(" -fa ").Append(fa);
            string ck = (settings.LlamaCacheK ?? "f16").ToLowerInvariant();
            string cv = (settings.LlamaCacheV ?? "f16").ToLowerInvariant();
            if (ValidKvType(ck)) sb.Append(" -ctk ").Append(ck);
            if (ValidKvType(cv)) sb.Append(" -ctv ").Append(cv);
            // 单 slot：这一条是实测出来的性能开关。llama.cpp 默认 --parallel 4（4 个
            // slot 平分上下文），在 6GB 卡上多个 slot 互相争抢显存与调度，解码实测
            // 只有 ~23 tok/s；改成 1 个 slot 后同样条件升到 ~37 tok/s（同一模型、
            // 同一批文本）。汉化是单请求串行发出的，本来也用不到多 slot。
            sb.Append(" --parallel ").Append(Math.Max(1, Math.Min(8, settings.LlamaParallel)));
            // 采样参数必须与 game-pipeline.js 请求里发送的一致：模型作者推荐
            // 低温度 + 窄核采样（llama 自身默认 0.8/0.95 对翻译任务偏“发散”）。
            sb.Append(" --temp ").Append(SamplerTemperature.ToString(CultureInfo.InvariantCulture));
            sb.Append(" --top-p ").Append(SamplerTopP.ToString(CultureInfo.InvariantCulture));
            // 退化复读时可通过 /metrics 判断；也可以据此诊断“卡住”。
            sb.Append(" --metrics");
            sb.Append(" --no-webui");
            return sb.ToString();
        }

        // 与 game-pipeline.js 的默认采样参数保持一致（可用环境变量覆盖）。
        public const double SamplerTemperature = 0.3;
        public const double SamplerTopP = 0.8;

        private static bool ValidKvType(string t)
        {
            string[] ok = { "f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1" };
            foreach (var x in ok) if (x == t) return true;
            return false;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);
        [DllImport("kernel32.dll")]
        private static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo, uint cbJobObjectInfoLength);
        [DllImport("kernel32.dll")]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr hObject);

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
            public long ProcessMemoryLimit;
            public long JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }
        private const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100;

        // ---------------- model list ----------------
        private void LoadModels()
        {
            modelMap.Clear();
            cmbModel.Items.Clear();
            if (!Directory.Exists(settings.ModelDir))
            {
                Log("模型目录不存在: " + settings.ModelDir);
                return;
            }
            try
            {
                foreach (var f in Directory.GetFiles(settings.ModelDir, "*.gguf", SearchOption.AllDirectories))
                {
                    var name = Path.GetFileName(f);
                    if (!modelMap.ContainsKey(name)) modelMap[name] = f;
                }
            }
            catch (Exception ex) { Log("扫描模型失败: " + ex.Message); }
            foreach (var n in modelMap.Keys.OrderBy(x => x)) cmbModel.Items.Add(n);
            if (cmbModel.Items.Count > 0) cmbModel.SelectedIndex = 0;
            Log("模型目录: " + settings.ModelDir + "（检测到 " + cmbModel.Items.Count + " 个模型）");
            WarnIfModelTooSmall();
        }

        // Measured on this machine (v2.4): a 0.8B model produced 0 usable
        // translations out of 126 lines, 1.8B got 121/126, 4B got 126/126.
        // Telling the user *before* a long run beats letting them discover it.
        private void WarnIfModelTooSmall()
        {
            var name = cmbModel.SelectedItem as string;
            if (string.IsNullOrEmpty(name)) return;
            var m = Regex.Match(name, @"(?<![0-9.])(\d+(?:\.\d+)?)\s*B(?![a-zA-Z0-9])", RegexOptions.IgnoreCase);
            if (!m.Success) return;
            double b;
            if (!double.TryParse(m.Groups[1].Value, System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out b)) return;
            if (b < 1.5)
            {
                Log("⚠ 模型适配提示：" + name + " 参数量偏小（约 " + b + "B）。实测这类模型在本工具"
                    + "的逐行协议下容易整批失败/产出不可用译文（0.8B 实测 126 条中 0 条可用）。"
                    + "建议改用 4B 级别模型（如 Galtransl-v4-4B）；仅显存非常紧张时再考虑 1.8B。");
            }
            else if (b < 3)
            {
                Log("提示：" + name + " 为 " + b + "B 级别模型，翻译质量/稳定性略低于 4B 级别"
                    + "（实测 1.8B 约 96% 条目成功），显存允许时建议用 4B 模型。");
            }
        }


        private void ChooseModelDir()
        {
            var fbd = new FolderBrowserDialog { Description = "选择存放 GGUF 翻译模型的文件夹", SelectedPath = Directory.Exists(settings.ModelDir) ? settings.ModelDir : "D:\\" };
            if (fbd.ShowDialog() == DialogResult.OK)
            {
                settings.ModelDir = fbd.SelectedPath;
                SaveSettings();
                LoadModels();
            }
        }

        private void ResolveNode()
        {
            string[] cands = { Path.Combine(appDir, "node", "node.exe"), @"D:\nodejs\node.exe", Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\nodejs\node.exe"), @"C:\Program Files\nodejs\node.exe" };
            foreach (var c in cands)
                if (File.Exists(c)) { nodePath = c; return; }
            try
            {
                var psi = new ProcessStartInfo("node", "--version") { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true };
                using (var p = Process.Start(psi)) { p.WaitForExit(3000); if (p.ExitCode == 0) nodePath = "node"; }
            }
            catch { }
            if (nodePath == "") Log("警告：未找到 node.exe（已尝试 exe 旁 node\\、D:\\nodejs\\node.exe 等），汉化功能将不可用。");
            else Log("Node: " + nodePath);
            string ruby = Path.Combine(appDir, "ruby", "bin", "ruby.exe");
            if (!File.Exists(ruby)) Log("警告：未找到便携 Ruby（" + ruby + "），VX Ace 游戏将无法汉化。");
        }

        private void Log(string s)
        {
            if (log == null) return; // NormalizeSettings() runs before BuildUi()
            if (log.InvokeRequired) log.BeginInvoke(new Action(() => Log(s)));
            else { log.AppendText(DateTime.Now.ToString("HH:mm:ss ") + s + "\r\n"); log.ScrollToCaret(); }
        }

        // ---------------- list management ----------------
        private void OnDrop(object sender, DragEventArgs e)
        {
            var files = (string[])e.Data.GetData(DataFormats.FileDrop);
            foreach (var f in files) AddPath(f);
            RefreshList();
        }

        private void AddGame()
        {
            var ofd = new OpenFileDialog { Filter = "Game.exe|Game.exe|所有文件|*.*", Title = "选择游戏的 Game.exe" };
            if (ofd.ShowDialog() == DialogResult.OK) { AddPath(ofd.FileName); RefreshList(); }
        }

        private void AddPath(string p)
        {
            string dir = Directory.Exists(p) ? p : Path.GetDirectoryName(p);
            var gi = Detect(dir);
            if (gi == null) { Log("不是可识别的 RPG Maker MV/MZ/VX Ace 游戏: " + dir); return; }
            if (games.Any(g => string.Equals(g.Dir, dir, StringComparison.OrdinalIgnoreCase))) { Log("已在列表中：" + dir); return; }
            games.Add(gi);
            SaveGamesCache();
            Log("已添加：" + gi.Dir + " [" + gi.Kind + (gi.AlreadyCn ? ", 已汉化]" : "]"));
        }

        private GameItem Detect(string dir)
        {
            // MV/MZ data can live in www\data or directly in the game root (NW.js
            // packaged MZ builds). VX Ace uses Data\*.rvdata2 or Game.rgss3a.
            var dataDir = FindJsonDataDir(dir);
            string kind = null;
            bool rootLayout = false;
            if (dataDir != null)
            {
                rootLayout = string.Equals(dataDir, Path.Combine(dir, "data"), StringComparison.OrdinalIgnoreCase);
                bool mz = File.Exists(Path.Combine(dir, "js", "rmmz_core.js")) ||
                          (rootLayout && File.Exists(Path.Combine(dir, "js", "rmmz_core.js")));
                if (mz) kind = "MZ";
                else if (File.Exists(Path.Combine(dir, "www", "js", "rpg_core.js")) || rootLayout) kind = "MV";
                else kind = "MV";
            }
            else if (File.Exists(Path.Combine(dir, "Game.rgss3a")) ||
                     (Directory.Exists(Path.Combine(dir, "Data")) && Directory.GetFiles(Path.Combine(dir, "Data"), "*.rvdata2").Length > 0))
            {
                kind = "VXAce";
                var vxData = Path.Combine(dir, "Data");
                if (Directory.Exists(vxData)) { dataDir = vxData; rootLayout = true; }
            }
            if (kind == null) return null;
            if (kind == "VXAce") rootLayout = true;

            long bytes = 0;
            try
            {
                if (kind == "VXAce")
                {
                    var arch = Path.Combine(dir, "Game.rgss3a");
                    if (File.Exists(arch)) bytes = new FileInfo(arch).Length;
                    else foreach (var f in Directory.GetFiles(Path.Combine(dir, "Data"), "*.rvdata2")) bytes += new FileInfo(f).Length;
                }
                else if (dataDir != null) foreach (var f in Directory.GetFiles(dataDir, "*.json")) bytes += new FileInfo(f).Length;
            }
            catch { }

            bool already = IsAlreadyTranslated(dir, kind, dataDir);
            return new GameItem
            {
                Dir = dir, Kind = kind, DataBytes = bytes, AlreadyCn = already,
                DataDir = dataDir, RootLayout = rootLayout,
                Status = already ? "已汉化(跳过)" : "待汉化"
            };
        }

        // The json data folder for MV/MZ: www\data first, then <root>\data (NW.js
        // packaged MZ builds ship the data folder next to Game.exe).
        private static string FindJsonDataDir(string dir)
        {
            foreach (var cand in new[]
            {
                Path.Combine(dir, "www", "data"),
                Path.Combine(dir, "data"),
                Path.Combine(dir, "Data"),
            })
            {
                try
                {
                    if (Directory.Exists(cand) && Directory.GetFiles(cand, "*.json").Length > 0) return cand;
                }
                catch { }
            }
            return null;
        }

        // "Already translated" must be decided from the data that is actually in
        // the game *now*, never from the mere existence of a backup folder: a user
        // who ran 卸载汉化(还原原版) still has data_原版备份 and would otherwise be
        // skipped forever.
        private static bool IsAlreadyTranslated(string dir, string kind, string dataDir)
        {
            if (kind == "VXAce") return false; // packed binary data: let 检查翻译 decide
            if (dataDir == null) return false;
            long cn = 0, kana = 0;
            try
            {
                long budget = 8L * 1024 * 1024, used = 0;
                foreach (var f in Directory.GetFiles(dataDir, "*.json"))
                {
                    var fi = new FileInfo(f);
                    if (used >= budget) break;
                    string t;
                    long take = Math.Min(budget - used, fi.Length);
                    using (var fs = new FileStream(f, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    {
                        var buf = new byte[take];
                        int n = fs.Read(buf, 0, buf.Length);
                        t = Encoding.UTF8.GetString(buf, 0, n);
                    }
                    used += take;
                    foreach (var ch in t)
                    {
                        int c = (int)ch;
                        if (c >= 0x4e00 && c <= 0x9fff) cn++;
                        else if (c >= 0x3040 && c <= 0x30ff) kana++;
                    }
                    if (used >= budget) break;
                }
            }
            catch { return false; }
            return cn > 500 && kana < cn * 0.2;
        }

        private void ChooseScanFolder()
        {
            var cur = txtScanPath.Text.Trim();
            var fbd = new FolderBrowserDialog
            {
                Description = "选择要扫描的文件夹（将递归查找 Game.exe）",
                SelectedPath = Directory.Exists(cur) ? cur : "K:\\"
            };
            if (fbd.ShowDialog() == DialogResult.OK)
            {
                txtScanPath.Text = fbd.SelectedPath;
                ScanRoot(fbd.SelectedPath);
            }
        }

        private void ScanRoot(string root)
        {
            if (busy) return;
            busy = true;
            lblStatus.Text = "扫描中…";
            var th = new Thread(() =>
            {
                games.Clear();
                Walk(root, 0);
                settings.ScanPath = root;
                SaveSettings();
                SaveGamesCache();
                BeginInvoke(new Action(() => { RefreshList(); lblStatus.Text = "扫描完成（共 " + games.Count + " 个游戏）"; busy = false; }));
            });
            th.IsBackground = true;
            th.Start();
        }

        private void Walk(string dir, int depth)
        {
            if (depth > 9) return;
            try
            {
                var files = Directory.GetFiles(dir, "Game.exe");
                if (files.Length > 0)
                {
                    var gi = Detect(dir);
                    if (gi != null) games.Add(gi);
                }
                foreach (var d in Directory.GetDirectories(dir))
                    if (!d.EndsWith("node_modules"))
                        Walk(d, depth + 1);
            }
            catch { }
        }

        private void RefreshList()
        {
            list.Items.Clear();
            foreach (var g in games)
            {
                var it = new ListViewItem(g.Dir);
                it.SubItems.Add(g.Kind);
                it.SubItems.Add(g.Status);
                it.SubItems.Add((g.DataBytes / 1024).ToString() + "KB");
                list.Items.Add(it);
            }
        }

        private void ToggleSelectAll()
        {
            if (list.Items.Count == 0) return;
            if (list.SelectedIndices.Count == list.Items.Count) list.SelectedItems.Clear();
            else { list.BeginUpdate(); foreach (ListViewItem it in list.Items) it.Selected = true; list.EndUpdate(); }
        }

        private void RefreshStatus()
        {
            if (busy) return;
            lblStatus.Text = "刷新状态中…";
            var th = new Thread(() =>
            {
                foreach (var g in games)
                {
                    var d = Detect(g.Dir);
                    if (d != null) { g.Kind = d.Kind; g.AlreadyCn = d.AlreadyCn; g.DataBytes = d.DataBytes; g.Status = d.Status; }
                }
                SaveGamesCache();
                BeginInvoke(new Action(() => { RefreshList(); lblStatus.Text = "刷新完成"; }));
            });
            th.IsBackground = true;
            th.Start();
        }

        // ---------------- games cache / context menu ----------------
        private string GamesCachePath() { return Path.Combine(WorkDir(), "games-cache.json"); }

        private void SaveGamesCache()
        {
            try
            {
                var ser = new DataContractJsonSerializer(typeof(List<GameItem>));
                using (var fs = File.Create(GamesCachePath())) ser.WriteObject(fs, games);
            }
            catch { }
        }

        private void LoadGamesCache()
        {
            try
            {
                var p = GamesCachePath();
                if (!File.Exists(p)) return;
                var ser = new DataContractJsonSerializer(typeof(List<GameItem>));
                using (var fs = File.OpenRead(p))
                {
                    var g = (List<GameItem>)ser.ReadObject(fs);
                    if (g != null) { games = g; RefreshList(); Log("已加载上次扫描列表（" + games.Count + " 个游戏）"); }
                }
            }
            catch { }
        }

        private GameItem SelectedSingle()
        {
            var sel = SelectedGames();
            return sel.Count > 0 ? sel[0] : null;
        }

        private void LaunchSelected()
        {
            var g = SelectedSingle();
            if (g == null) { MessageBox.Show("请先选择一个游戏"); return; }
            var exe = Path.Combine(g.Dir, "Game.exe");
            if (!File.Exists(exe)) { Log("未找到 Game.exe: " + g.Dir); return; }
            try { Process.Start(exe); Log("已启动: " + exe); }
            catch (Exception ex) { Log("启动失败: " + ex.Message); }
        }

        private void OpenInExplorer()
        {
            var g = SelectedSingle();
            if (g == null) { MessageBox.Show("请先选择一个游戏"); return; }
            try { Process.Start("explorer.exe", "\"" + g.Dir + "\""); }
            catch (Exception ex) { Log("打开资源管理器失败: " + ex.Message); }
        }

        // ---------------- pause / stop ----------------
        private string WorkDir() { var w = Path.Combine(appDir, "work"); Directory.CreateDirectory(w); return w; }

        private void TogglePause()
        {
            var flag = Path.Combine(WorkDir(), "pause.flag");
            if (paused)
            {
                try { if (File.Exists(flag)) File.Delete(flag); } catch { }
                paused = false;
                btnPause.Text = "暂停";
                if (miPause != null) miPause.Text = "暂停";
                Log("已继续");
            }
            else
            {
                try { File.WriteAllText(flag, "1"); } catch (Exception ex) { Log("暂停失败: " + ex.Message); return; }
                paused = true;
                btnPause.Text = "继续";
                if (miPause != null) miPause.Text = "继续";
                Log("已暂停（当前批次完成后生效）");
            }
        }

        private void StopTranslate()
        {
            var flag = Path.Combine(WorkDir(), "stop.flag");
            try { File.WriteAllText(flag, "1"); Log("已请求终止（当前批次完成后停止，进度已保留）"); } catch (Exception ex) { Log("终止失败: " + ex.Message); }
        }

        // ---------------- translate ----------------
        private void StartTranslate(bool all)
        {
            if (busy) return;
            List<GameItem> sel;
            if (all)
            {
                sel = games.Where(g => !g.AlreadyCn).ToList();
                if (sel.Count == 0) { MessageBox.Show("没有可汉化的游戏（全部已汉化或跳过）"); return; }
            }
            else
            {
                sel = SelectedGames();
                if (sel.Count == 0) { MessageBox.Show("请先在列表中选择要汉化的游戏"); return; }
            }
            if (nodePath == "") { MessageBox.Show("未找到 node.exe"); return; }
            if (cmbModel.SelectedItem == null) { MessageBox.Show("没有可用模型，请检查模型目录"); return; }

            var modelName = (string)cmbModel.SelectedItem;
            var modelPath = modelMap[modelName];
            settings.Device = cmbDevice.SelectedIndex == 1 ? "cpu" : "gpu";
            SaveSettings();

            busy = true;
            btnStart.Enabled = false;
            btnStartAll.Enabled = false;
            lblStatus.Text = "启动模型…";
            var th = new Thread(() =>
            {
                if (!EnsureLlama(modelPath))
                {
                    BeginInvoke(new Action(() =>
                    {
                        busy = false;
                        btnStart.Enabled = true;
                        btnStartAll.Enabled = true;
                        lblStatus.Text = "就绪";
                        MessageBox.Show("内置 llama 启动失败，请查看日志");
                    }));
                    return;
                }
                bool stopped = false;
                foreach (var g in sel)
                {
                    if (stopped) break;
                    if (g.AlreadyCn) { SetStatus(g, "已汉化(跳过)"); continue; }
                    try { TranslateGame(g, modelName, ref stopped); }
                    catch (Exception ex) { Log("处理失败: " + g.Dir + " " + ex.Message); SetStatus(g, "失败"); }
                }
                BeginInvoke(new Action(() =>
                {
                    busy = false;
                    btnStart.Enabled = true;
                    btnStartAll.Enabled = true;
                    if (paused) { paused = false; btnPause.Text = "暂停"; }
                    lblStatus.Text = "完成";
                }));
            });
            th.IsBackground = true;
            th.Start();
        }

        private void StartTranslateGame(GameItem g)
        {
            if (busy) return;
            if (nodePath == "") { MessageBox.Show("未找到 node.exe"); return; }
            if (cmbModel.SelectedItem == null) { MessageBox.Show("没有可用模型，请检查模型目录"); return; }

            var modelName = (string)cmbModel.SelectedItem;
            var modelPath = modelMap[modelName];
            settings.Device = cmbDevice.SelectedIndex == 1 ? "cpu" : "gpu";
            SaveSettings();

            busy = true;
            btnStart.Enabled = false;
            btnStartAll.Enabled = false;
            lblStatus.Text = "启动模型…";
            var th = new Thread(() =>
            {
                if (!EnsureLlama(modelPath))
                {
                    BeginInvoke(new Action(() =>
                    {
                        busy = false;
                        btnStart.Enabled = true;
                        btnStartAll.Enabled = true;
                        lblStatus.Text = "就绪";
                        MessageBox.Show("内置 llama 启动失败，请查看日志");
                    }));
                    return;
                }
                bool stopped = false;
                try { TranslateGame(g, modelName, ref stopped); }
                catch (Exception ex) { Log("处理失败: " + g.Dir + " " + ex.Message); SetStatus(g, "失败"); }
                BeginInvoke(new Action(() =>
                {
                    busy = false;
                    btnStart.Enabled = true;
                    btnStartAll.Enabled = true;
                    if (paused) { paused = false; btnPause.Text = "暂停"; }
                    lblStatus.Text = "完成";
                }));
            });
            th.IsBackground = true;
            th.Start();
        }

        private List<GameItem> SelectedGames()
        {
            var r = new List<GameItem>();
            foreach (int i in list.SelectedIndices) r.Add(games[i]);
            return r;
        }

        private void SetStatus(GameItem g, string s)
        {
            g.Status = s;
            BeginInvoke(new Action(() =>
            {
                foreach (ListViewItem it in list.Items)
                    if (games[it.Index] == g) it.SubItems[2].Text = s;
            }));
        }

        private void TranslateGame(GameItem g, string modelName, ref bool stopped)
        {
            var bak = Path.Combine(g.Dir, "data_原版备份");
            if (!Directory.Exists(bak))
            {
                Log("备份原版数据：" + g.Dir);
                if (g.Kind == "VXAce")
                {
                    Directory.CreateDirectory(bak);
                    var arch = Path.Combine(g.Dir, "Game.rgss3a");
                    if (File.Exists(arch)) File.Copy(arch, Path.Combine(bak, "Game.rgss3a"));
                    else if (Directory.Exists(Path.Combine(g.Dir, "Data"))) CopyDir(Path.Combine(g.Dir, "Data"), Path.Combine(bak, "Data"));
                }
                else CopyDir(string.IsNullOrEmpty(g.DataDir) ? Path.Combine(g.Dir, "www", "data") : g.DataDir, bak);
            }
            WriteRestoreBat(g.Dir);
            SetStatus(g, "汉化中…");
            Log("开始翻译: " + g.Dir + "（模型 " + modelName + "）");
            var work = WorkDir();
            var promptFile = Path.Combine(work, "prompt.txt");
            try
            {
                File.WriteAllText(promptFile,
                    string.IsNullOrWhiteSpace(settings.Prompt) ? Settings.DefaultPrompt : settings.Prompt,
                    new UTF8Encoding(false));
            }
            catch (Exception ex) { Log("写入提示词文件失败: " + ex.Message); }
            var psi = new ProcessStartInfo(nodePath)
            {
                Arguments = "\"" + Path.Combine(appDir, "game-pipeline.js") + "\" \"" + g.Dir + "\" \"" + modelName + "\" \"" + work + "\" " + settings.Port + " translate \"" + promptFile + "\"",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            using (var p = Process.Start(psi))
            {
                p.OutputDataReceived += (s, e) => { if (!string.IsNullOrEmpty(e.Data)) { Log(e.Data); UpdateProgress(e.Data, g); } };
                p.ErrorDataReceived += (s, e) => { if (!string.IsNullOrEmpty(e.Data)) Log("ERR: " + e.Data); };
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                if (!p.WaitForExit(8 * 60 * 60 * 1000)) { try { p.Kill(); } catch { } Log("超时，已终止: " + g.Dir); }
            }
            var stopFlag = Path.Combine(work, "stop.flag");
            if (File.Exists(stopFlag))
            {
                try { File.Delete(stopFlag); } catch { }
                stopped = true;
                SetStatus(g, "已终止");
                Log("已按用户要求终止，后续游戏跳过");
                return;
            }
            BackupChinese(g);
            WriteRestoreCnBat(g.Dir);
            SetStatus(g, "已完成");
            Log("完成: " + g.Dir);
        }

        private string GameWorkName(string dir)
        {
            var b = Path.GetFileName(dir.TrimEnd('\\', '/'));
            return Regex.Replace(b, @"[^a-zA-Z0-9\u4e00-\u9fff]", "_");
        }

        private void CheckTranslation()
        {
            if (busy) return;
            var g = SelectedSingle();
            if (g == null) { MessageBox.Show("请先选择一个游戏"); return; }
            if (nodePath == "") { MessageBox.Show("未找到 node.exe"); return; }
            busy = true;
            lblStatus.Text = "检查翻译中…";
            var work = WorkDir();
            var psi = new ProcessStartInfo(nodePath)
            {
                Arguments = "\"" + Path.Combine(appDir, "game-pipeline.js") + "\" \"" + g.Dir + "\" dummy \"" + work + "\" " + settings.Port + " check",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            var th = new Thread(() =>
            {
                try
                {
                    using (var p = Process.Start(psi))
                    {
                        p.OutputDataReceived += (s, e) => { if (!string.IsNullOrEmpty(e.Data)) Log(e.Data); };
                        p.ErrorDataReceived += (s, e) => { if (!string.IsNullOrEmpty(e.Data)) Log("ERR: " + e.Data); };
                        p.BeginOutputReadLine();
                        p.BeginErrorReadLine();
                        p.WaitForExit(30 * 60 * 1000);
                    }
                }
                catch (Exception ex) { Log("检查失败: " + ex.Message); }
                var uf = Path.Combine(work, GameWorkName(g.Dir) + "-untranslated.json");
                if (!File.Exists(uf)) { BeginInvoke(new Action(() => { busy = false; lblStatus.Text = "检查完成（未生成结果）"; })); return; }
                int badN = 0, pendN = 0, fatalN = 0, suspectN = 0;
                try
                {
                    var ser = new DataContractJsonSerializer(typeof(UntranslatedResult));
                    using (var fs = File.OpenRead(uf))
                    {
                        var r = (UntranslatedResult)ser.ReadObject(fs);
                        if (r != null)
                        {
                            badN = r.bad != null ? r.bad.Length : 0;
                            pendN = r.pending != null ? r.pending.Length : 0;
                            fatalN = r.fatal != null ? r.fatal.Length : 0;
                            suspectN = r.suspect != null ? r.suspect.Length : 0;
                            // File written by an older build: derive the tiers.
                            if (fatalN == 0 && suspectN == 0 && badN > 0) fatalN = badN;
                        }
                    }
                }
                catch (Exception ex) { Log("读取检查结果失败: " + ex.Message); }
                BeginInvoke(new Action(() =>
                {
                    busy = false;
                    lblStatus.Text = "检查完成";
                    Log("检查翻译完成：" + g.Dir + " —— 必须重翻 " + fatalN + " 条（控制符丢失/复读/截断/乱码），"
                        + "建议复核 " + suspectN + " 条（残留日文/长度/标点），未翻译 " + pendN + " 条");
                    if (badN + pendN > 0 &&
                        MessageBox.Show("发现必须重翻 " + fatalN + " 条、建议复核 " + suspectN + " 条、未翻译 " + pendN
                            + " 条。是否立即重新翻译这些内容？（保留已有译文，只替换结果更好的）", "检查翻译",
                            MessageBoxButtons.YesNo) == DialogResult.Yes)
                    {
                        StartTranslateGame(g);
                    }
                }));
            });
            th.IsBackground = true;
            th.Start();
        }

        private void UpdateProgress(string line, GameItem g)
        {
            var m = Regex.Match(line, @"PROGRESS (\d+) / (\d+)");
            if (m.Success)
            {
                int cur = int.Parse(m.Groups[1].Value), tot = int.Parse(m.Groups[2].Value);
                BeginInvoke(new Action(() => { if (tot > 0) progress.Value = Math.Min(100, cur * 100 / tot); }));
            }
            else if (line.StartsWith("EXTRACTED")) BeginInvoke(new Action(() => progress.Value = 5));
            else if (line.StartsWith("DONE")) BeginInvoke(new Action(() => progress.Value = 100));
        }

        private void RestoreSelected()
        {
            if (busy) return;
            foreach (var g in SelectedGames())
            {
                var bak = Path.Combine(g.Dir, "data_原版备份");
                if (!Directory.Exists(bak)) { Log("无备份，无法还原: " + g.Dir); continue; }
                try
                {
                    if (File.Exists(Path.Combine(bak, "Game.rgss3a")))
                    {
                        File.Copy(Path.Combine(bak, "Game.rgss3a"), Path.Combine(g.Dir, "Game.rgss3a"), true);
                        var leftover = Path.Combine(g.Dir, "Game.rgss3a.new");
                        if (File.Exists(leftover)) File.Delete(leftover);
                    }
                    if (Directory.Exists(Path.Combine(bak, "Data")))
                    {
                        var data = Path.Combine(g.Dir, "Data");
                        if (Directory.Exists(data)) Directory.Delete(data, true);
                        CopyDir(Path.Combine(bak, "Data"), data);
                    }
                    if (Directory.GetFiles(bak, "*.json").Length > 0)
                    {
                        // MV/MZ backup is a flat copy of the data folder: restore
                        // it into the folder the backup came from (www\data or
                        // <root>\data for NW.js packaged builds).
                        var data = string.IsNullOrEmpty(g.DataDir)
                            ? Path.Combine(g.Dir, "www", "data")
                            : g.DataDir;
                        if (Directory.Exists(data)) Directory.Delete(data, true);
                        CopyDir(bak, data);
                    }
                    Log("已还原: " + g.Dir);
                    SetStatus(g, "已还原");
                }
                catch (Exception ex) { Log("还原失败: " + g.Dir + " " + ex.Message); }
            }
        }

        private void RestoreChinese()
        {
            if (busy) return;
            foreach (var g in SelectedGames())
            {
                var bak = Path.Combine(g.Dir, "data_汉化备份");
                if (!Directory.Exists(bak)) { Log("无汉化备份，无法恢复: " + g.Dir); continue; }
                try
                {
                    if (File.Exists(Path.Combine(bak, "Game.rgss3a")))
                        File.Copy(Path.Combine(bak, "Game.rgss3a"), Path.Combine(g.Dir, "Game.rgss3a"), true);
                    if (Directory.Exists(Path.Combine(bak, "Data")))
                    {
                        var data = Path.Combine(g.Dir, "Data");
                        if (Directory.Exists(data)) Directory.Delete(data, true);
                        CopyDir(Path.Combine(bak, "Data"), data);
                    }
                    if (Directory.Exists(Path.Combine(bak, "Map001.json")) || Directory.GetFiles(bak, "*.json").Length > 0)
                    {
                        // Flat backup -> restore into the live data folder.
                        var data = string.IsNullOrEmpty(g.DataDir) ? Path.Combine(g.Dir, "www", "data") : g.DataDir;
                        if (Directory.Exists(data)) Directory.Delete(data, true);
                        CopyDir(bak, data);
                    }
                    Log("已恢复汉化版: " + g.Dir);
                    SetStatus(g, "已恢复汉化");
                }
                catch (Exception ex) { Log("恢复汉化失败: " + g.Dir + " " + ex.Message); }
            }
        }

        private void BackupChinese(GameItem g)
        {
            try
            {
                var bak = Path.Combine(g.Dir, "data_汉化备份");
                if (g.Kind == "VXAce")
                {
                    Directory.CreateDirectory(bak);
                    var arch = Path.Combine(g.Dir, "Game.rgss3a");
                    if (File.Exists(arch)) File.Copy(arch, Path.Combine(bak, "Game.rgss3a"), true);
                    else if (Directory.Exists(Path.Combine(g.Dir, "Data")))
                    {
                        var d = Path.Combine(bak, "Data");
                        if (Directory.Exists(d)) Directory.Delete(d, true);
                        CopyDir(Path.Combine(g.Dir, "Data"), d);
                    }
                }
                else
                {
                    // Flat layout, matching data_原版备份 so both backup folders
                    // (and the restore bats) describe the same folder.
                    var d = bak;
                    var src = string.IsNullOrEmpty(g.DataDir) ? Path.Combine(g.Dir, "www", "data") : g.DataDir;
                    if (Directory.Exists(d)) Directory.Delete(d, true);
                    CopyDir(src, d);
                }
                Log("已备份汉化版: " + bak);
            }
            catch (Exception ex) { Log("备份汉化版失败: " + ex.Message); }
        }

        private static void CopyDir(string src, string dst)
        {
            Directory.CreateDirectory(dst);
            foreach (var f in Directory.GetFiles(src)) File.Copy(f, Path.Combine(dst, Path.GetFileName(f)), true);
            foreach (var d in Directory.GetDirectories(src))
            {
                var sub = Path.Combine(dst, Path.GetFileName(d));
                CopyDir(d, sub);
            }
        }

        private static void WriteRestoreBat(string gameDir)
        {
            var bat = Path.Combine(gameDir, "一键还原汉化前.bat");
            var lines = new[]
            {
                "@echo off",
                "chcp 65001 >nul",
                "taskkill /f /im Game.exe >nul 2>&1",
                "cd /d \"%~dp0\"",
                "if exist \"data_原版备份\\Game.rgss3a\" (",
                "  del /f /q \"Game.rgss3a\" >nul 2>&1",
                "  copy /y \"data_原版备份\\Game.rgss3a\" \"Game.rgss3a\" >nul",
                ")",
                "if exist \"data_原版备份\\Data\" (",
                "  if exist \"Data\" rmdir /s /q \"Data\"",
                "  mkdir \"Data\" >nul 2>&1",
                "  xcopy /e /i /y \"data_原版备份\\Data\\*\" \"Data\" >nul",
                ")",
                "if exist \"data_原版备份\\Map001.json\" (",
                "  if exist \"www\\data\" (",
                "    rmdir /s /q \"www\\data\"",
                "    mkdir \"www\\data\" >nul 2>&1",
                "    xcopy /e /i /y \"data_原版备份\\*\" \"www\\data\" >nul",
                "  ) else (",
                "    if exist \"data\" rmdir /s /q \"data\"",
                "    mkdir \"data\" >nul 2>&1",
                "    xcopy /e /i /y \"data_原版备份\\*\" \"data\" >nul",
                "  )",
                ")",
                "echo.",
                "echo 还原完成！游戏数据已恢复为汉化前的原版。",
                "pause"
            };
            File.WriteAllLines(bat, lines, new UTF8Encoding(false));
        }

        private static void WriteRestoreCnBat(string gameDir)
        {
            var bat = Path.Combine(gameDir, "一键恢复汉化.bat");
            var lines = new[]
            {
                "@echo off",
                "chcp 65001 >nul",
                "taskkill /f /im Game.exe >nul 2>&1",
                "cd /d \"%~dp0\"",
                "if exist \"data_汉化备份\\Game.rgss3a\" (",
                "  del /f /q \"Game.rgss3a\" >nul 2>&1",
                "  copy /y \"data_汉化备份\\Game.rgss3a\" \"Game.rgss3a\" >nul",
                ")",
                "if exist \"data_汉化备份\\Data\" (",
                "  if exist \"Data\" rmdir /s /q \"Data\"",
                "  mkdir \"Data\" >nul 2>&1",
                "  xcopy /e /i /y \"data_汉化备份\\Data\\*\" \"Data\" >nul",
                ")",
                "if exist \"data_汉化备份\\Map001.json\" (",
                "  if exist \"www\\data\" (",
                "    rmdir /s /q \"www\\data\"",
                "    mkdir \"www\\data\" >nul 2>&1",
                "    xcopy /e /i /y \"data_汉化备份\\*\" \"www\\data\" >nul",
                "  ) else (",
                "    if exist \"data\" rmdir /s /q \"data\"",
                "    mkdir \"data\" >nul 2>&1",
                "    xcopy /e /i /y \"data_汉化备份\\*\" \"data\" >nul",
                "  )",
                ")",
                "echo.",
                "echo 已恢复汉化版！",
                "pause"
            };
            File.WriteAllLines(bat, lines, new UTF8Encoding(false));
        }
    }

    public class SettingsForm : Form
    {
        private static readonly string[] KvTypes = { "f16", "q8_0", "q4_0", "bf16", "f32" };
        private readonly Settings _work;
        private TabControl tabs;
        private NumericUpDown nudCtx, nudNgl, nudBatch, nudUbatch, nudThreads, nudPoll, nudMem, nudPort, nudParallel;
        private ComboBox cmbFa, cmbK, cmbV;
        private ComboBox cmbPreset;
        private bool _applyingPreset;
        private TextBox txtPrompt;

        public Settings Result { get; private set; }

        public SettingsForm(Settings current, int selectedTab)
        {
            _work = Clone(current);
            Text = "GameTranslator 设置";
            Width = 660;
            Height = 620;
            StartPosition = FormStartPosition.CenterParent;
            MinimizeBox = false;
            MaximizeBox = false;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            Font = new Font("Microsoft YaHei", 9f);

            tabs = new TabControl { Dock = DockStyle.Fill };
            tabs.TabPages.Add(BuildLlamaTab());
            tabs.TabPages.Add(BuildPromptTab());
            tabs.SelectedIndex = selectedTab == 1 ? 1 : 0;

            var btns = new Panel { Dock = DockStyle.Bottom, Height = 54 };
            var btnOk = new Button { Text = "保存", Width = 90, Location = new Point(430, 12), Anchor = AnchorStyles.Right | AnchorStyles.Bottom };
            var btnCancel = new Button { Text = "取消", Width = 90, Location = new Point(530, 12), Anchor = AnchorStyles.Right | AnchorStyles.Bottom };
            btnOk.Click += (s, e) => SaveAndClose();
            btnCancel.Click += (s, e) => { DialogResult = DialogResult.Cancel; Close(); };
            btns.Controls.Add(btnOk);
            btns.Controls.Add(btnCancel);

            Controls.Add(tabs);
            Controls.Add(btns);
        }

        private TabPage BuildLlamaTab()
        {
            var tp = new TabPage("llama 运行参数");
            var tbl = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Padding = new Padding(12), AutoScroll = true };
            tbl.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 220));
            tbl.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

            cmbPreset = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 160 };
            cmbPreset.Items.AddRange(new object[] { "RTX 高性能", "通用均衡", "省显存", "自定义" });
            cmbPreset.SelectedIndex = PresetIndex(_work.LlamaPreset);
            cmbPreset.SelectedIndexChanged += (s, e) => ApplyPresetSelection();
            AddRow(tbl, "性能预设", cmbPreset, "RTX 高性能 = FlashAttention + f16 KV + 单 slot + 2048/512 批次");

            nudCtx = Num(512, 65536, _work.LlamaContext);
            nudNgl = Num(0, 999, _work.LlamaGpuLayers);
            nudBatch = Num(32, 8192, _work.LlamaBatch);
            nudUbatch = Num(16, 4096, _work.LlamaUbatch);
            nudThreads = Num(0, 256, _work.LlamaThreads);
            nudPoll = Num(0, 100, _work.LlamaPoll);
            nudParallel = Num(1, 8, _work.LlamaParallel < 1 ? 1 : _work.LlamaParallel);
            nudMem = Num(0, 1048576, _work.MaxMemoryMB);
            nudPort = Num(1024, 65535, _work.Port);
            cmbFa = Combo(new[] { "auto", "on", "off" }, _work.LlamaFlashAttn ?? "auto");
            cmbK = Combo(KvTypes, _work.LlamaCacheK ?? "f16");
            cmbV = Combo(KvTypes, _work.LlamaCacheV ?? "f16");
            WireCustom(nudCtx); WireCustom(nudNgl); WireCustom(nudBatch); WireCustom(nudUbatch);
            WireCustom(nudThreads); WireCustom(nudPoll); WireCustom(cmbFa); WireCustom(cmbK); WireCustom(cmbV);
            WireCustom(nudParallel);

            AddRow(tbl, "-c 上下文长度", nudCtx, "建议 4096；越大占显存越多");
            AddRow(tbl, "-ngl GPU 层数", nudNgl, "99 = 全部层进显存；显存不足时降低");
            AddRow(tbl, "-b 批大小", nudBatch, "提示词处理的逻辑批大小，CUDA 可调大");
            AddRow(tbl, "-ub 物理批大小", nudUbatch, "每次实际送入 GPU 的批大小");
            AddRow(tbl, "-t CPU 线程数", nudThreads, "0 = 自动（CUDA 模式自动用 4，降低 CPU 占用）");
            AddRow(tbl, "--poll 轮询等级", nudPoll, "0 = 省 CPU（推荐），50 = 默认，100 = 响应最快");
            AddRow(tbl, "-fa FlashAttention", cmbFa, "auto 让 llama 自动决定");
            AddRow(tbl, "-ctk K 缓存类型", cmbK, "f16 = 最快（推荐）；q8_0 省一半 KV 显存但解码明显变慢");
            AddRow(tbl, "-ctv V 缓存类型", cmbV, "f16 = 最快（推荐）；q8_0 省一半 KV 显存但解码明显变慢");
            AddRow(tbl, "--parallel 并发 slot", nudParallel, "1 = 最快（推荐）；本工具是串行请求，多 slot 只会互相争抢显存");
            AddRow(tbl, "服务端口", nudPort, "重启 llama 后生效");
            AddRow(tbl, "llama 内存上限(MB)", nudMem, "0 = 自动（总内存-4GB）");

            var note = new Label
            {
                Dock = DockStyle.Bottom,
                Height = 46,
                Padding = new Padding(6),
                ForeColor = Color.DarkOrange,
                Text = "注意：llama 不支持运行中热切换模型或参数。修改后请点击“确定修改llama设置”，llama 会重启，新参数在下次开始汉化时生效。"
            };
            var bottom = new Panel { Dock = DockStyle.Bottom, Height = 58 };
            var btnOkLlama = new Button { Text = "确定修改llama设置", Width = 200, Location = new Point(12, 12) };
            btnOkLlama.Click += (s, e) => SaveAndClose();
            var btnReset = new Button { Text = "恢复默认参数", Width = 130, Location = new Point(230, 12) };
            btnReset.Click += (s, e) => ResetLlamaDefaults();
            bottom.Controls.Add(btnOkLlama);
            bottom.Controls.Add(btnReset);

            tp.Controls.Add(tbl);
            tp.Controls.Add(note);
            tp.Controls.Add(bottom);
            return tp;
        }

        private TabPage BuildPromptTab()
        {
            var tp = new TabPage("翻译提示词");
            var lbl = new Label
            {
                Dock = DockStyle.Top,
                Height = 64,
                Padding = new Padding(6),
                Text = "发给翻译模型的主提示词。提示词中的 {lines} 会被替换为待翻译的编号行；若不包含 {lines}，待翻译行会自动追加在末尾。留空保存将恢复默认提示词。"
            };
            txtPrompt = new TextBox
            {
                Dock = DockStyle.Fill,
                Multiline = true,
                ScrollBars = ScrollBars.Both,
                AcceptsReturn = true,
                Font = new Font("Microsoft YaHei", 10f)
            };
            var btnDef = new Button { Text = "恢复默认提示词", Width = 140, Dock = DockStyle.Bottom, Height = 38 };
            btnDef.Click += (s, e) => txtPrompt.Text = Settings.DefaultPrompt;
            txtPrompt.Text = string.IsNullOrWhiteSpace(_work.Prompt) ? Settings.DefaultPrompt : _work.Prompt;
            tp.Controls.Add(txtPrompt);
            tp.Controls.Add(lbl);
            tp.Controls.Add(btnDef);
            return tp;
        }

        private static NumericUpDown Num(int min, int max, int val)
        {
            return new NumericUpDown { Minimum = min, Maximum = max, Value = Math.Max(min, Math.Min(max, val)), Width = 160 };
        }

        private static ComboBox Combo(string[] items, string val)
        {
            var c = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 160 };
            c.Items.AddRange(items);
            if (!c.Items.Contains(val)) val = (string)items[0];
            c.SelectedItem = val;
            return c;
        }

        private static void AddRow(TableLayoutPanel tbl, string label, Control ctrl, string hint)
        {
            int row = tbl.RowCount++;
            tbl.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
            var l = new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left };
            var h = new Label { Text = hint, AutoSize = true, ForeColor = Color.Gray };
            var wrap = new Panel { Dock = DockStyle.Fill };
            ctrl.Location = new Point(0, 3);
            h.Location = new Point(172, 8);
            wrap.Controls.Add(ctrl);
            wrap.Controls.Add(h);
            tbl.Controls.Add(l, 0, row);
            tbl.Controls.Add(wrap, 1, row);
        }

        private static int PresetIndex(string preset)
        {
            switch (preset)
            {
                case "rtx": return 0;
                case "balanced": return 1;
                case "vram": return 2;
                case "custom": return 3;
                default: return 1; // auto 显示为通用均衡
            }
        }

        private static string PresetKey(string sel)
        {
            switch (sel)
            {
                case "RTX 高性能": return "rtx";
                case "省显存": return "vram";
                case "通用均衡": return "balanced";
                default: return "custom";
            }
        }

        private void ApplyPresetSelection()
        {
            var sel = (string)cmbPreset.SelectedItem;
            _applyingPreset = true;
            try
            {
                if (sel == "RTX 高性能") SetControls(4096, 99, 2048, 512, 4, 0, "on", "q8_0", "q8_0");
                else if (sel == "省显存") SetControls(4096, 99, 256, 128, 2, 0, "on", "q8_0", "q8_0");
                else if (sel == "通用均衡") SetControls(4096, 99, 512, 256, 0, 0, "auto", "f16", "f16");
            }
            finally { _applyingPreset = false; }
        }

        private void SetControls(int ctx, int ngl, int b, int ub, int t, int poll, string fa, string k, string v)
        {
            nudCtx.Value = ctx; nudNgl.Value = ngl; nudBatch.Value = b; nudUbatch.Value = ub;
            nudThreads.Value = t; nudPoll.Value = poll;
            cmbFa.SelectedItem = fa; cmbK.SelectedItem = k; cmbV.SelectedItem = v;
        }

        private void WireCustom(Control c)
        {
            var n = c as NumericUpDown;
            if (n != null) { n.ValueChanged += (s, e) => MarkCustom(); return; }
            var cb = c as ComboBox;
            if (cb != null) cb.SelectedIndexChanged += (s, e) => MarkCustom();
        }

        private void MarkCustom()
        {
            if (_applyingPreset || cmbPreset == null) return;
            if ((string)cmbPreset.SelectedItem != "自定义") cmbPreset.SelectedItem = "自定义";
        }

        private void SaveAndClose()
        {
            if (Collect())
            {
                Result = _work;
                DialogResult = DialogResult.OK;
                Close();
            }
        }

        private bool Collect()
        {
            _work.LlamaContext = (int)nudCtx.Value;
            _work.LlamaGpuLayers = (int)nudNgl.Value;
            _work.LlamaBatch = (int)nudBatch.Value;
            _work.LlamaUbatch = (int)nudUbatch.Value;
            _work.LlamaThreads = (int)nudThreads.Value;
            _work.LlamaPoll = (int)nudPoll.Value;
            _work.LlamaFlashAttn = (string)cmbFa.SelectedItem;
            _work.LlamaCacheK = (string)cmbK.SelectedItem;
            _work.LlamaCacheV = (string)cmbV.SelectedItem;
            _work.LlamaParallel = (int)nudParallel.Value;
            _work.Port = (int)nudPort.Value;
            _work.MaxMemoryMB = (int)nudMem.Value;
            _work.Prompt = string.IsNullOrWhiteSpace(txtPrompt.Text) ? Settings.DefaultPrompt : txtPrompt.Text;
            _work.LlamaPreset = PresetKey((string)cmbPreset.SelectedItem);
            return true;
        }

        private void ResetLlamaDefaults()
        {
            cmbPreset.SelectedItem = "通用均衡";
            _applyingPreset = true;
            SetControls(4096, 99, 512, 256, 0, 0, "auto", "f16", "f16");
            _applyingPreset = false;
            nudPort.Value = 18080;
            nudMem.Value = 0;
        }

        private static Settings Clone(Settings src)
        {
            return new Settings
            {
                ModelDir = src.ModelDir,
                LlamaDir = src.LlamaDir,
                Device = src.Device,
                MaxMemoryMB = src.MaxMemoryMB,
                ScanPath = src.ScanPath,
                Port = src.Port,
                LlamaContext = src.LlamaContext,
                LlamaGpuLayers = src.LlamaGpuLayers,
                LlamaBatch = src.LlamaBatch,
                LlamaUbatch = src.LlamaUbatch,
                LlamaThreads = src.LlamaThreads,
                LlamaPoll = src.LlamaPoll,
                LlamaFlashAttn = src.LlamaFlashAttn,
                LlamaCacheK = src.LlamaCacheK,
                LlamaCacheV = src.LlamaCacheV,
                Prompt = src.Prompt,
                LlamaPreset = src.LlamaPreset
            };
        }
    }

    public static class Program
    {
        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }
}
