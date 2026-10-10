using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using GameTranslatorV3.Core;

namespace GameTranslatorV3
{
    /// <summary>
    /// Main window — one page, no tabs.
    ///
    /// The layout is a left/right split rather than a set of pages, because every control
    /// in this tool is either "what to translate" or "what is happening now", and those two
    /// need to be visible together while a batch runs. Tabs hid the progress behind a click
    /// and made it easy to lose sight of a running task.
    ///
    ///   left   the game list, with the file management actions above it
    ///   right  model selection, the detailed progress panel, the task controls, the log
    ///
    /// Conflicting actions still cannot both be enabled: 开始 and 终止 are mutually
    /// exclusive, as are 暂停 and 继续, list editing is disabled during a run, and
    /// 卸载/恢复 require exactly one game selected because they rewrite game files.
    /// </summary>
    public sealed class MainForm : Form
    {
        private readonly string _root;
        private readonly Settings _settings;
        private readonly PipelineRunner _runner;
        private readonly List<GameItem> _games = new List<GameItem>();

        private ListView _list;
        private TextBox _log;
        private Label _status;
        private ComboBox _cmbModel;
        private Button _btnModelRefresh, _btnModelStart, _btnModelStop;
        private Label _lblModelState;

        // detailed progress panel
        private Label _lblBatch, _lblCurrent, _lblCounts, _lblRate, _lblElapsed, _lblModelNow;
        private ProgressBar _barGame, _barBatch;
        private System.Windows.Forms.Timer _ticker;
        private DateTime _runStarted;
        private long _reqCount, _failCount, _skipCount;
        private int _batchTotal, _batchDone;
        private string _currentGame = "";
        private DateTime _lastProgressAt = DateTime.MinValue;
        private int _lastProgressCount, _gameTotal;

        private Button _btnScan, _btnAdd, _btnRefresh, _btnSelectAll, _btnClearSel;
        private Button _btnStartSel, _btnStartAll, _btnPause, _btnResume, _btnStop, _btnCheck;
        private Button _btnUninstall, _btnRestore, _btnOpenLog, _btnClearLog, _btnSettings;
        private CancellationTokenSource _cts;
        private bool _paused, _running;

        public MainForm(string root)
        {
            _root = root;
            _settings = Settings.Load(root);
            _runner = new PipelineRunner(root)
            {
                WorkDir = _settings.WorkDir,
                Port = _settings.Port,
                Model = _settings.Model,
                MaxAttempts = _settings.MaxAttempts,
                GameBudget = TimeSpan.FromMinutes(_settings.GameBudgetMinutes),
                StalledAfter = TimeSpan.FromMinutes(_settings.StalledAfterMinutes)
            };
            if (!string.IsNullOrEmpty(_settings.PipelineJs) && File.Exists(_settings.PipelineJs))
                _runner.PipelineJs = _settings.PipelineJs;
            _runner.Output += OnPipelineLine;
            _runner.AttemptFailed += (game, why) => { _failCount++; AppendLog("⚠ " + game + "：" + why); };

            BuildUi();
            RefreshModels();
            LoadGames();

            _ticker = new System.Windows.Forms.Timer { Interval = 1000 };
            _ticker.Tick += (s, e) => UpdateProgressPanel();
            _ticker.Start();

            FormClosing += OnFormClosing;
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (_runner.IsRunning)
            {
                var answer = MessageBox.Show(this,
                    "翻译任务仍在运行。\n\n" +
                    "是 = 停止任务并退出（已完成的译文会保留）\n" +
                    "否 = 让任务在后台继续（关掉窗口后它不会停）\n" +
                    "取消 = 返回窗口",
                    "退出前确认", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);

                if (answer == DialogResult.Cancel) { e.Cancel = true; return; }
                if (answer == DialogResult.No) { AppendLog("窗口关闭，翻译任务继续在后台运行。"); return; }
                AppendLog("正在停止翻译任务…");
                if (_cts != null) _cts.Cancel();
            }
            _runner.Dispose();
        }

        // ------------------------------------------------------------------ layout ---

        private void BuildUi()
        {
            Text = "RPG Maker 汉化管理器 v3";
            Size = new Size(1220, 780);
            MinimumSize = new Size(1000, 640);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 9f);

            var split = new SplitContainer
            {
                Dock = DockStyle.Fill,
                Orientation = Orientation.Vertical,
                SplitterDistance = 640,
                SplitterWidth = 6
            };

            split.Panel1.Controls.Add(BuildGamePane());
            split.Panel2.Controls.Add(BuildControlPane());

            var bottom = new Panel { Dock = DockStyle.Bottom, Height = 28 };
            _status = new Label
            {
                Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft,
                Padding = new Padding(10, 0, 0, 0), Text = "就绪"
            };
            bottom.Controls.Add(_status);

            Controls.Add(split);
            Controls.Add(bottom);
            UpdateButtons();
        }

        /// <summary>Left: what to translate.</summary>
        private Control BuildGamePane()
        {
            // toolbar of file-management actions (always safe)
            var bar = new FlowLayoutPanel
            {
                Dock = DockStyle.Top, Height = 40, Padding = new Padding(6, 6, 6, 0),
                WrapContents = false, AutoScroll = true
            };
            _btnScan = MakeButton("扫描文件夹", (s, e) => ScanFolder());
            _btnAdd = MakeButton("添加游戏", (s, e) => AddGame());
            _btnRefresh = MakeButton("刷新", (s, e) => { LoadGames(); RefreshModels(); });
            _btnSelectAll = MakeButton("全选", (s, e) => SetAllChecked(true));
            _btnClearSel = MakeButton("取消全选", (s, e) => SetAllChecked(false));
            bar.Controls.AddRange(new Control[] { _btnScan, _btnAdd, _btnRefresh, _btnSelectAll, _btnClearSel });

            _list = new ListView
            {
                Dock = DockStyle.Fill, View = View.Details, CheckBoxes = true,
                FullRowSelect = true, GridLines = true, HideSelection = false
            };
            _list.Columns.Add("", 26);
            _list.Columns.Add("游戏", 300);
            _list.Columns.Add("引擎", 60);
            _list.Columns.Add("条目", 60);
            _list.Columns.Add("进度", 120);
            _list.Columns.Add("状态", 160);
            _list.ItemChecked += (s, e) =>
            {
                var g = e.Item.Tag as GameItem;
                if (g != null) g.Checked = e.Item.Checked;
                UpdateButtons();
            };
            _list.SelectedIndexChanged += (s, e) => UpdateButtons();
            AttachGameContextMenu();

            var pane = new Panel { Dock = DockStyle.Fill };
            pane.Controls.Add(_list);
            pane.Controls.Add(bar);
            return pane;
        }

        /// <summary>Right: the model, the progress, the controls, the log.</summary>
        private Control BuildControlPane()
        {
            var host = new Panel { Dock = DockStyle.Fill, Padding = new Padding(6, 0, 0, 0) };

            // ---- model row -------------------------------------------------------
            var modelBox = new GroupBox { Dock = DockStyle.Top, Height = 64, Text = "翻译模型" };
            var modelRow = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(6, 4, 6, 0), WrapContents = false };
            _cmbModel = new ComboBox { Width = 300, DropDownStyle = ComboBoxStyle.DropDownList };
            _btnModelRefresh = MakeButton("刷新列表", (s, e) => RefreshModels());
            _btnModelStart = MakeButton("启动模型", (s, e) => StartLlama());
            _btnModelStop = MakeButton("停止模型", (s, e) => StopLlama());
            _lblModelState = new Label { Width = 150, TextAlign = ContentAlignment.MiddleLeft, Text = "状态：未知", ForeColor = Color.DimGray };
            modelRow.Controls.AddRange(new Control[] { _cmbModel, _btnModelRefresh, _btnModelStart, _btnModelStop, _lblModelState });
            modelBox.Controls.Add(modelRow);

            // ---- detailed progress ----------------------------------------------
            var progBox = new GroupBox { Dock = DockStyle.Top, Height = 190, Text = "任务进度" };
            var grid = new TableLayoutPanel
            {
                Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 9,
                Padding = new Padding(8, 4, 8, 4)
            };
            _lblBatch = MakeStatLabel("批次：空闲");
            _barBatch = new ProgressBar { Dock = DockStyle.Top, Height = 16, Maximum = 1000 };
            _lblCurrent = MakeStatLabel("当前：—");
            _barGame = new ProgressBar { Dock = DockStyle.Top, Height = 16, Maximum = 1000 };
            _lblCounts = MakeStatLabel("条目：—    请求：0    失败：0    跳过：0");
            _lblRate = MakeStatLabel("速度：—");
            _lblElapsed = MakeStatLabel("用时：—");
            _lblModelNow = MakeStatLabel("模型：—");
            grid.Controls.Add(_lblBatch, 0, 0);
            grid.Controls.Add(_barBatch, 0, 1);
            grid.Controls.Add(_lblCurrent, 0, 2);
            grid.Controls.Add(_barGame, 0, 3);
            grid.Controls.Add(_lblCounts, 0, 4);
            grid.Controls.Add(_lblRate, 0, 5);
            grid.Controls.Add(_lblElapsed, 0, 6);
            grid.Controls.Add(_lblModelNow, 0, 7);
            progBox.Controls.Add(grid);

            // ---- task controls ---------------------------------------------------
            var actBox = new GroupBox { Dock = DockStyle.Top, Height = 104, Text = "任务控制" };
            var act1 = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 34, Padding = new Padding(6, 4, 0, 0), WrapContents = false };
            _btnStartSel = MakeButton("开始汉化选中", (s, e) => StartTranslation(false));
            _btnStartAll = MakeButton("全部汉化", (s, e) => StartTranslation(true));
            _btnPause = MakeButton("暂停", (s, e) => Pause());
            _btnResume = MakeButton("继续", (s, e) => Resume());
            _btnStop = MakeButton("终止", (s, e) => Stop());
            act1.Controls.AddRange(new Control[] { _btnStartSel, _btnStartAll, _btnPause, _btnResume, _btnStop });

            var act2 = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 34, Padding = new Padding(6, 0, 0, 0), WrapContents = false };
            _btnCheck = MakeButton("检查翻译", (s, e) => StartCheck());
            _btnUninstall = MakeButton("卸载汉化", (s, e) => Uninstall());
            _btnRestore = MakeButton("恢复汉化", (s, e) => Restore());
            _btnSettings = MakeButton("设置…", (s, e) => OpenSettings());
            _btnOpenLog = MakeButton("打开日志文件", (s, e) => OpenLogFiles());
            act2.Controls.AddRange(new Control[] { _btnCheck, _btnUninstall, _btnRestore, _btnSettings, _btnOpenLog });
            actBox.Controls.Add(act2);
            actBox.Controls.Add(act1);

            // ---- log -------------------------------------------------------------
            var logBox = new GroupBox { Dock = DockStyle.Fill, Text = "日志 / 错误" };
            _log = new TextBox
            {
                Dock = DockStyle.Fill, Multiline = true, ReadOnly = true,
                ScrollBars = ScrollBars.Both, WordWrap = false,
                Font = new Font("Consolas", 8.5f), BackColor = Color.FromArgb(250, 250, 250)
            };
            var logBar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 30, WrapContents = false };
            _btnClearLog = MakeButton("清空显示", (s, e) => _log.Clear());
            logBar.Controls.Add(_btnClearLog);
            logBox.Controls.Add(_log);
            logBox.Controls.Add(logBar);

            // Docked controls stack in reverse order of addition, so the log (fill) is
            // added first and the top rows last.
            host.Controls.Add(logBox);
            host.Controls.Add(actBox);
            host.Controls.Add(progBox);
            host.Controls.Add(modelBox);
            return host;
        }

        private static Button MakeButton(string text, EventHandler onClick)
        {
            var b = new Button { Text = text, AutoSize = true, Height = 28, Margin = new Padding(0, 0, 6, 4) };
            b.Click += onClick;
            return b;
        }

        private static Label MakeStatLabel(string text)
        {
            return new Label { Text = text, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, AutoSize = false, Height = 18 };
        }

        // -------------------------------------------------------------- model list ---

        /// <summary>
        /// Fill the model dropdown from the configured model directory.
        ///
        /// The selected model is what llama-server is launched with (-m), so this is the
        /// control that actually decides which model translates. The pipeline's own model
        /// argument is only a label — neither the v2 nor the v3 script loads a model, the
        /// server does.
        /// </summary>
        private void RefreshModels()
        {
            var previous = _settings.Model;
            _cmbModel.Items.Clear();
            var dir = _settings.ModelDir;
            if (Directory.Exists(dir))
            {
                foreach (var f in Directory.GetFiles(dir, "*.gguf").OrderBy(x => x))
                {
                    var name = Path.GetFileName(f);
                    if (IsNotATranslationModel(name)) continue;
                    _cmbModel.Items.Add(name);
                }
            }
            if (_cmbModel.Items.Count == 0)
            {
                _cmbModel.Items.Add("（模型目录里没有 .gguf 文件）");
                _cmbModel.SelectedIndex = 0;
                _cmbModel.Enabled = false;
            }
            else
            {
                _cmbModel.Enabled = true;
                int idx = _cmbModel.Items.IndexOf(previous);
                _cmbModel.SelectedIndex = idx >= 0 ? idx : 0;
                _settings.Model = Convert.ToString(_cmbModel.SelectedItem);
                _runner.Model = _settings.Model;
            }
            UpdateModelState();
        }

        /// <summary>
        /// Files in a model folder that must not appear in the translation model list.
        ///
        /// Both kinds fail in a way that wastes the user's time rather than saying what is
        /// wrong: a vision projector (mmproj-*) is not a model at all and cannot be served
        /// on its own, and a vision-language model such as Qwen2.5-VL translates text into
        /// nonsense because it expects an image. A 0.5B model is kept — the user may want
        /// it for a quick pass — but the list only offers things that can actually translate.
        /// </summary>
        private static bool IsNotATranslationModel(string fileName)
        {
            var n = fileName.ToLowerInvariant();
            if (n.StartsWith("mmproj")) return true;
            if (n.Contains("-vl-") || n.Contains("-vl.") || n.Contains("vision")) return true;
            if (n.Contains("clip") || n.Contains("llava")) return true;
            return false;
        }

        private void UpdateModelState()
        {
            bool up = false;
            try
            {
                using (var c = new System.Net.Sockets.TcpClient())
                {
                    var ar = c.BeginConnect("127.0.0.1", _settings.Port, null, null);
                    up = ar.AsyncWaitHandle.WaitOne(300) && c.Connected;
                }
            }
            catch { up = false; }
            _lblModelState.Text = up ? "状态：已就绪" : "状态：未启动";
            _lblModelState.ForeColor = up ? Color.SeaGreen : Color.DimGray;
            _btnModelStart.Enabled = !_running;
            _btnModelStop.Enabled = !_running && up;
        }

        // -------------------------------------------------------------- progress -----

        /// <summary>Redraw the progress panel. Driven by a timer so 用时 keeps counting.</summary>
        private void UpdateProgressPanel()
        {
            if (_running)
            {
                var el = DateTime.Now - _runStarted;
                _lblElapsed.Text = "用时：" + (el.TotalHours >= 1
                    ? (int)el.TotalHours + " 小时 " + el.Minutes + " 分"
                    : Math.Round(el.TotalMinutes, 1) + " 分");

                // rate from the last progress report, not from the batch start: a batch is
                // overwhelmingly dominated by whichever game is running now.
                if (_lastProgressAt != DateTime.MinValue && _lastProgressCount > 0)
                {
                    var span = (DateTime.Now - _lastProgressAt).TotalMinutes;
                    if (span > 0.05 && _gameTotal > 0)
                    {
                        var pct = 100.0 * _lastProgressCount / _gameTotal;
                        _lblRate.Text = "速度：本游戏 " + pct.ToString("0.0") + "%   " +
                            (_lastProgressCount / 1.0).ToString("0") + " / " + _gameTotal + " 条";
                    }
                }
            }

            _lblCounts.Text = "请求：" + _reqCount + "    失败：" + _failCount + "    跳过：" + _skipCount;
            _lblModelNow.Text = "模型：" + (_settings.Model ?? "—") + "    端口：" + _settings.Port;
            UpdateModelState();
        }

        private void ResetProgress()
        {
            _runStarted = DateTime.Now;
            _reqCount = _failCount = _skipCount = 0;
            _batchTotal = _batchDone = 0;
            _currentGame = "";
            _lastProgressAt = DateTime.MinValue;
            _lastProgressCount = 0;
            _gameTotal = 0;
            _barBatch.Value = 0;
            _barGame.Value = 0;
            _lblBatch.Text = "批次：准备中…";
            _lblCurrent.Text = "当前：—";
        }

        // ---------------------------------------------------------------- games ------

        private sealed class GameItem
        {
            public string Dir;
            public string Name;
            public string Engine = "?";
            public int Entries = -1;
            public bool Checked;
            public string Status = "";
            public string Exe;
            public string OpenDir;
            public string LaunchProblem;
        }

        private void LoadGames()
        {
            _games.Clear();
            var cache = Path.Combine(_settings.WorkDir, "games-cache.json");
            if (File.Exists(cache))
            {
                try
                {
                    foreach (var g in SimpleJson.Array(File.ReadAllText(cache, Encoding.UTF8)))
                    {
                        string dir = SimpleJson.Get(g, "Dir") ?? SimpleJson.Get(g, "dir");
                        if (string.IsNullOrEmpty(dir)) continue;
                        _games.Add(new GameItem
                        {
                            Dir = dir,
                            Name = Path.GetFileName(dir.TrimEnd('\\', '/')),
                            Engine = SimpleJson.Get(g, "Kind") ?? "?",
                            Entries = SimpleJson.GetInt(g, "Entries"),
                            Checked = false,
                            Status = SimpleJson.GetBool(g, "AlreadyCn") ? "已是中文，默认跳过" : ""
                        });
                    }
                }
                catch (Exception ex) { AppendLog("读取 games-cache.json 失败：" + ex.Message); }
            }
            RefreshList();
        }

        private void RefreshList()
        {
            _list.BeginUpdate();
            _list.Items.Clear();
            foreach (var g in _games)
            {
                if (g.Exe == null && g.LaunchProblem == null) ResolveLaunchTarget(g);
                var it = new ListViewItem("");
                it.SubItems.Add(g.Name);
                it.SubItems.Add(g.Engine);
                it.SubItems.Add(g.Entries >= 0 ? g.Entries.ToString() : "");
                it.SubItems.Add(ReadProgress(g));
                it.SubItems.Add(g.Status);
                it.Checked = g.Checked;
                it.Tag = g;
                _list.Items.Add(it);
            }
            _list.EndUpdate();
            _status.Text = "共 " + _games.Count + " 个游戏，已勾选 " + _games.Count(x => x.Checked) + " 个";
            UpdateButtons();
        }

        /// <summary>Read the pipeline's own report so the list never overstates progress.</summary>
        private string ReadProgress(GameItem g)
        {
            try
            {
                string safe = new string(Path.GetFileName(g.Dir).Where(c => char.IsLetterOrDigit(c) || c > 127).ToArray());
                string report = Path.Combine(_settings.WorkDir, safe + "-translate-report.json");
                if (!File.Exists(report)) return "";
                string txt = File.ReadAllText(report, Encoding.UTF8);
                int entries = SimpleJson.GetInt(txt, "entries");
                int done = SimpleJson.GetInt(txt, "translated");
                if (entries <= 0) return "";
                return done + "/" + entries + "  (" + Math.Round(100.0 * done / entries) + "%)";
            }
            catch { return ""; }
        }

        private void SetAllChecked(bool value)
        {
            foreach (var g in _games) g.Checked = value;
            foreach (ListViewItem it in _list.Items) it.Checked = value;
            UpdateButtons();
        }

        private void UpdateButtons()
        {
            int checkedGames = _games.Count(g => g.Checked);
            _btnStartSel.Enabled = !_running && checkedGames > 0;
            _btnStartAll.Enabled = !_running && _games.Count > 0;
            _btnStop.Enabled = _running;
            _btnPause.Enabled = _running && !_paused;
            _btnResume.Enabled = _running && _paused;
            _btnCheck.Enabled = !_running && checkedGames > 0;
            _btnScan.Enabled = !_running;
            _btnAdd.Enabled = !_running;
            _btnRefresh.Enabled = !_running;
            _btnSelectAll.Enabled = !_running;
            _btnClearSel.Enabled = !_running;
            _btnUninstall.Enabled = !_running && checkedGames == 1;
            _btnRestore.Enabled = !_running && checkedGames == 1;
            _btnSettings.Enabled = !_running;
            _cmbModel.Enabled = !_running && _cmbModel.Items.Count > 0 && !Convert.ToString(_cmbModel.SelectedItem).StartsWith("（");
            _btnModelRefresh.Enabled = !_running;
            _list.Enabled = !_running;
            UpdateModelState();
        }

        // ------------------------------------------------------------ scan / add -----

        private void ScanFolder()
        {
            using (var dlg = new FolderBrowserDialog { Description = "选择游戏所在文件夹（会递归查找 Game.exe / Game.rgss3a）" })
            {
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                ScanPath(dlg.SelectedPath);
            }
        }

        private void ScanPath(string path)
        {
            AppendLog("扫描 " + path + " …");
            int found = 0;
            try
            {
                foreach (var dir in Directory.EnumerateDirectories(path))
                {
                    if (IsGameDir(dir)) { AddOrUpdate(dir); found++; }
                    foreach (var sub in SafeDirs(dir)) if (IsGameDir(sub)) { AddOrUpdate(sub); found++; }
                }
            }
            catch (Exception ex)
            {
                AppendLog("扫描出错：" + ex.Message);
                _runner.LogError("扫描 " + path + " 失败：" + ex.Message);
            }
            RefreshList();
            AppendLog("扫描完成，识别到 " + found + " 个游戏目录。");
        }

        private static IEnumerable<string> SafeDirs(string dir)
        {
            try { return Directory.EnumerateDirectories(dir).ToList(); } catch { return new string[0]; }
        }

        private static bool IsGameDir(string dir)
        {
            try
            {
                if (File.Exists(Path.Combine(dir, "Game.exe"))) return true;
                if (File.Exists(Path.Combine(dir, "Game.rgss3a"))) return true;
                if (Directory.Exists(Path.Combine(dir, "www", "data"))) return true;
                return false;
            }
            catch { return false; }
        }

        private void AddOrUpdate(string dir)
        {
            if (_games.Any(g => string.Equals(g.Dir, dir, StringComparison.OrdinalIgnoreCase))) return;
            var item = new GameItem
            {
                Dir = dir,
                Name = Path.GetFileName(dir.TrimEnd('\\', '/')),
                Engine = DetectEngine(dir),
                Entries = -1,
                Checked = false
            };
            ResolveLaunchTarget(item);
            _games.Add(item);
        }

        private static void ResolveLaunchTarget(GameItem g)
        {
            g.OpenDir = g.Dir;
            try
            {
                string preferred = Path.Combine(g.Dir, "Game.exe");
                if (File.Exists(preferred)) { g.Exe = preferred; return; }
                var exes = Directory.GetFiles(g.Dir, "*.exe").Where(f => !IsToolExe(Path.GetFileName(f))).ToList();
                if (exes.Count > 0)
                {
                    g.Exe = exes.FirstOrDefault(f => Path.GetFileName(f).IndexOf("game", StringComparison.OrdinalIgnoreCase) >= 0) ?? exes[0];
                    return;
                }
                g.LaunchProblem = "这个目录里没有可执行文件（.exe），无法从这里启动。\n" +
                                  "它看起来是解包后的数据目录，游戏本体在上一层。";
            }
            catch (Exception ex) { g.LaunchProblem = "检查可执行文件时出错：" + ex.Message; }
        }

        private static bool IsToolExe(string name)
        {
            var n = name.ToLowerInvariant();
            return n.StartsWith("mtool") || n.StartsWith("nwjs") || n == "nw.exe" ||
                   n.StartsWith("unins") || n.StartsWith("vcredist") ||
                   n.StartsWith("npptools") || n.Contains("translator") ||
                   n.StartsWith("ruby") || n.StartsWith("node") ||
                   n.StartsWith("一键") || n.StartsWith("启动器");
        }

        private static string DetectEngine(string dir)
        {
            try
            {
                string data = Directory.Exists(Path.Combine(dir, "www", "data"))
                    ? Path.Combine(dir, "www", "data") : Path.Combine(dir, "data");
                if (!Directory.Exists(data)) return "?";
                var files = Directory.GetFiles(data).Select(Path.GetFileName).ToList();
                if (files.Any(f => f.EndsWith(".rvdata2", StringComparison.OrdinalIgnoreCase))) return "VX Ace";
                if (files.Any(f => f.EndsWith(".rvdata", StringComparison.OrdinalIgnoreCase))) return "VX";
                if (files.Any(f => f.EndsWith(".json", StringComparison.OrdinalIgnoreCase))) return "MV/MZ";
                return "?";
            }
            catch { return "?"; }
        }

        private void AddGame()
        {
            using (var dlg = new OpenFileDialog { Filter = "RPG Maker 游戏|Game.exe;Game.rgss3a;Game.rgss2a|所有文件|*.*" })
            {
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                AddOrUpdate(Path.GetDirectoryName(dlg.FileName));
                RefreshList();
            }
        }

        private List<GameItem> Selected(bool all)
        {
            return all ? _games.ToList() : _games.Where(g => g.Checked).ToList();
        }

        // ------------------------------------------------------------- context menu --

        private void AttachGameContextMenu()
        {
            var menu = new ContextMenuStrip();
            var miLaunch = new ToolStripMenuItem("启动游戏");
            miLaunch.Click += (s, e) => Launch(CurrentGame());
            var miOpen = new ToolStripMenuItem("打开所在目录");
            miOpen.Click += (s, e) => OpenFolder(CurrentGame());
            var miOpenData = new ToolStripMenuItem("打开数据目录 (data)");
            miOpenData.Click += (s, e) => OpenDataDir(CurrentGame());
            var miCopy = new ToolStripMenuItem("复制游戏路径");
            miCopy.Click += (s, e) => CopyPath(CurrentGame());
            menu.Items.Add(miLaunch);
            menu.Items.Add(miOpen);
            menu.Items.Add(miOpenData);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(miCopy);
            menu.Opening += (s, e) =>
            {
                var g = CurrentGame();
                bool has = g != null;
                bool can = has && !string.IsNullOrEmpty(g.Exe) && File.Exists(g.Exe);
                miLaunch.Enabled = can;
                miLaunch.Text = can ? "启动游戏" : "启动游戏（找不到 exe）";
                miOpen.Enabled = has;
                miOpenData.Enabled = has && GetDataDir(g) != null;
                miCopy.Enabled = has;
            };
            _list.ContextMenuStrip = menu;
            _list.MouseDown += (s, e) =>
            {
                if (e.Button != MouseButtons.Right) return;
                var hit = _list.GetItemAt(e.X, e.Y);
                if (hit != null) { hit.Selected = true; hit.Focused = true; }
            };
        }

        private GameItem CurrentGame()
        {
            var it = _list != null && _list.SelectedItems.Count > 0 ? _list.SelectedItems[0] : null;
            return it == null ? null : it.Tag as GameItem;
        }

        private void Launch(GameItem g)
        {
            if (g == null) return;
            if (string.IsNullOrEmpty(g.Exe) || !File.Exists(g.Exe))
            {
                MessageBox.Show(this, g.LaunchProblem ?? ("找不到可执行文件：\n" + g.Dir),
                    "无法启动游戏", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            try
            {
                Process.Start(new ProcessStartInfo(g.Exe) { WorkingDirectory = g.Dir, UseShellExecute = true });
                AppendLog("已启动游戏：" + Path.GetFileName(g.Exe) + "   (" + g.Name + ")");
            }
            catch (Exception ex)
            {
                AppendLog("启动游戏失败：" + ex.Message);
                _runner.LogError("启动游戏 " + g.Name + " 失败：" + ex.Message);
                MessageBox.Show(this, "启动失败：\n" + ex.Message, "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void OpenFolder(GameItem g)
        {
            if (g == null) return;
            string dir = !string.IsNullOrEmpty(g.OpenDir) && Directory.Exists(g.OpenDir) ? g.OpenDir : g.Dir;
            try { Process.Start("explorer.exe", "/select,\"" + dir + "\""); }
            catch (Exception ex) { AppendLog("打开目录失败：" + ex.Message); }
        }

        private static string GetDataDir(GameItem g)
        {
            if (g == null) return null;
            string mv = Path.Combine(g.Dir, "www", "data");
            if (Directory.Exists(mv)) return mv;
            string data = Path.Combine(g.Dir, "data");
            return Directory.Exists(data) ? data : null;
        }

        private void OpenDataDir(GameItem g)
        {
            string dir = GetDataDir(g);
            if (dir == null)
            {
                MessageBox.Show(this, "这个游戏目录里没有 data 文件夹。\n\n" +
                    "如果是打包的（Game.rgss3a / Game.rgss2a），数据在归档内部。",
                    "没有数据目录", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            try { Process.Start("explorer.exe", "/select,\"" + dir + "\""); }
            catch (Exception ex) { AppendLog("打开数据目录失败：" + ex.Message); }
        }

        private void CopyPath(GameItem g)
        {
            if (g == null) return;
            try { Clipboard.SetText(g.Dir); AppendLog("已复制路径：" + g.Dir); }
            catch (Exception ex) { AppendLog("复制失败：" + ex.Message); }
        }

        // ----------------------------------------------------------- translation -----

        private async void StartTranslation(bool all)
        {
            var list = Selected(all);
            if (list.Count == 0)
            {
                MessageBox.Show(this, "请先勾选要汉化的游戏。", "没有选中游戏", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            // The model has to be running; offer to start it rather than failing later.
            if (!IsPortOpen())
            {
                var answer = MessageBox.Show(this,
                    "翻译模型服务还没有启动。\n\n是否现在启动「" + _settings.Model + "」？\n\n" +
                    "模型加载需要 30-45 秒，管线会自动等待。",
                    "需要启动模型", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
                if (answer == DialogResult.Cancel) return;
                if (answer == DialogResult.Yes)
                {
                    StartLlama();
                    for (int i = 0; i < 60 && !IsPortOpen(); i++) await Task.Delay(1000);
                    if (!IsPortOpen())
                    {
                        MessageBox.Show(this, "模型服务启动失败或超时，请查看日志。", "启动失败");
                        return;
                    }
                }
            }

            _running = true; _paused = false;
            _cts = new CancellationTokenSource();
            ResetProgress();
            _barGame.Maximum = 1000;
            _batchTotal = list.Count;
            UpdateButtons();

            var skipped = new List<string>();
            var failed = new List<string>();

            for (int i = 0; i < list.Count; i++)
            {
                var g = list[i];
                if (_cts.IsCancellationRequested) break;
                _batchDone = i;
                _lblBatch.Text = "批次：" + (i + 1) + " / " + list.Count + " 个游戏";
                _barBatch.Value = Math.Min(1000, (int)(1000.0 * i / list.Count));

                if (g.Status.Contains("跳过"))
                {
                    skipped.Add(g.Name + "（已是中文）");
                    _skipCount++;
                    _runner.LogSkip(g.Name + "  已跳过：检测为已是中文");
                    continue;
                }
                while (_paused && !_cts.IsCancellationRequested) await Task.Delay(500);
                if (_cts.IsCancellationRequested) break;

                _currentGame = g.Name;
                _lblCurrent.Text = "当前：" + g.Name;
                _barGame.Value = 0;
                _lastProgressAt = DateTime.MinValue;
                _lastProgressCount = 0;
                AppendLog("═══ 开始 " + g.Name + " ═══");

                var outcome = await _runner.RunAsync(g.Dir, _settings.PromptFile, _cts.Token);
                if (outcome.Succeeded) { g.Status = "已完成"; AppendLog("✔ " + g.Name + " 完成（尝试 " + outcome.AttemptsUsed + " 次）"); }
                else if (outcome.SkipReason == "用户终止") { AppendLog("■ 已终止"); break; }
                else { g.Status = "失败已跳过"; failed.Add(g.Name + "：" + outcome.SkipReason); AppendLog("✖ " + g.Name + " 已跳过 —— " + outcome.SkipReason); }
                RefreshList();
            }

            _running = false;
            _cts = null;
            _barBatch.Value = 1000;
            _lblBatch.Text = "批次：已完成 " + _batchDone + " / " + _batchTotal;
            _lblCurrent.Text = "当前：空闲";
            UpdateButtons();

            var sb = new StringBuilder("批次结束。\n完成 " + _batchDone + " 个");
            if (skipped.Count > 0) sb.Append("，跳过 " + skipped.Count + " 个已是中文");
            if (failed.Count > 0)
            {
                sb.Append("，失败并跳过 " + failed.Count + " 个：\n");
                foreach (var f in failed.Take(8)) sb.Append("  · " + f + "\n");
                sb.Append("\n详细记录见 work\\errors.log 与 work\\skips.log");
            }
            MessageBox.Show(this, sb.ToString(), "翻译批次结果", MessageBoxButtons.OK,
                failed.Count > 0 ? MessageBoxIcon.Warning : MessageBoxIcon.Information);
        }

        private bool IsPortOpen()
        {
            try
            {
                using (var c = new System.Net.Sockets.TcpClient())
                {
                    var ar = c.BeginConnect("127.0.0.1", _settings.Port, null, null);
                    return ar.AsyncWaitHandle.WaitOne(400) && c.Connected;
                }
            }
            catch { return false; }
        }

        private void StartCheck()
        {
            var list = _games.Where(g => g.Checked).ToList();
            if (list.Count == 0) { MessageBox.Show(this, "请先勾选游戏。", "提示"); return; }
            _running = true; UpdateButtons();
            foreach (var g in list)
            {
                AppendLog("═══ 质检 " + g.Name + " ═══");
                try
                {
                    var psi = new ProcessStartInfo(_runner.NodeExe)
                    {
                        Arguments = PipelineRunner.Join(new[]
                        {
                            _runner.PipelineJs, g.Dir, _runner.WorkDir, _runner.Port.ToString(), "check"
                        }),
                        WorkingDirectory = Path.GetDirectoryName(_runner.PipelineJs),
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        StandardOutputEncoding = Encoding.UTF8
                    };
                    using (var p = Process.Start(psi))
                    {
                        string o = p.StandardOutput.ReadToEnd();
                        p.WaitForExit(600000);
                        foreach (var line in o.Split('\n')) if (line.Trim().Length > 0) AppendLog(line.TrimEnd());
                    }
                }
                catch (Exception ex)
                {
                    AppendLog("质检失败：" + ex.Message);
                    _runner.LogError("质检 " + g.Name + " 失败：" + ex.Message);
                }
            }
            _running = false; UpdateButtons();
        }

        private void Pause() { _paused = true; AppendLog("⏸ 已暂停：当前请求完成后不再开始下一个游戏。"); UpdateButtons(); }
        private void Resume() { _paused = false; AppendLog("▶ 已继续。"); UpdateButtons(); }

        private void Stop()
        {
            if (_cts == null) return;
            if (MessageBox.Show(this, "确定终止当前批次？已经完成的译文会保留，下次可从进度继续。",
                    "终止", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
            AppendLog("■ 正在终止…");
            _cts.Cancel();
            _runner.StopCurrent();
        }

        // --------------------------------------------------------------- llama -------

        private void StartLlama()
        {
            try
            {
                string exe = Path.Combine(_root, "llama", "llama-server.exe");
                if (!File.Exists(exe)) { MessageBox.Show(this, "未找到 " + exe); return; }
                string model = Convert.ToString(_cmbModel.SelectedItem);
                if (string.IsNullOrEmpty(model) || model.StartsWith("（"))
                {
                    MessageBox.Show(this, "请先在「翻译模型」里选择一个模型。", "未选择模型");
                    return;
                }
                string modelPath = Path.Combine(_settings.ModelDir, model);
                if (!File.Exists(modelPath)) { MessageBox.Show(this, "未找到模型文件：\n" + modelPath); return; }

                // Replace any server this app previously started, so switching models takes
                // effect. A server started elsewhere is left alone.
                StopLlama(quiet: true);

                var psi = new ProcessStartInfo(exe)
                {
                    Arguments = PipelineRunner.Join(new[]
                    {
                        "-m", modelPath, "--host", "127.0.0.1", "--port", _settings.Port.ToString(),
                        "-c", "4096", "-ngl", "99", "-b", "1024", "-ub", "256", "-t", "4",
                        "--poll", "0", "-fa", "on", "-ctk", "f16", "-ctv", "f16", "--parallel", "1",
                        "--temp", "0.3", "--top-p", "0.8", "--metrics", "--no-webui"
                    }),
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                var proc = Process.Start(psi);
                if (proc != null) _runner.RememberLlamaProcess(proc.Id);

                _settings.Model = model;
                _runner.Model = model;
                _settings.Save(_root);
                AppendLog("已启动模型服务：" + model + "（端口 " + _settings.Port + "）。加载需要 30-45 秒，管线会等待。");
                _lblModelState.Text = "状态：加载中…";
                _lblModelState.ForeColor = Color.DarkOrange;
            }
            catch (Exception ex)
            {
                AppendLog("启动模型服务失败：" + ex.Message);
                _runner.LogError("启动模型服务失败：" + ex.Message);
            }
        }

        private void StopLlama() { StopLlama(false); }

        private void StopLlama(bool quiet)
        {
            // Only a server this app started is stopped, identified by PID. Killing by the
            // name llama-server would also take down one the user started on purpose.
            int killed = _runner.StopOwnLlama();
            if (!quiet) AppendLog(killed > 0 ? "已停止本程序启动的模型服务。" : "没有本程序启动的模型服务在运行。");
            UpdateModelState();
        }

        // -------------------------------------------------------------- settings -----

        /// <summary>
        /// Settings live in a dialog rather than on the page: they are edited rarely and
        /// would crowd out the list and the progress, which are what the page is for.
        /// </summary>
        private void OpenSettings()
        {
            using (var dlg = new Form())
            {
                dlg.Text = "设置";
                dlg.Size = new Size(620, 400);
                dlg.StartPosition = FormStartPosition.CenterParent;
                dlg.FormBorderStyle = FormBorderStyle.FixedDialog;
                dlg.MaximizeBox = false; dlg.MinimizeBox = false;
                dlg.Font = Font;

                var t = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Padding = new Padding(12) };
                t.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 130));
                t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

                var txtDir = new TextBox { Width = 380, Text = _settings.ModelDir };
                var txtPort = new TextBox { Width = 80, Text = _settings.Port.ToString() };
                var txtPrompt = new TextBox { Width = 380, Text = _settings.PromptFile };
                var txtPipe = new TextBox { Width = 380, Text = _settings.PipelineJs };
                var txtAttempts = new TextBox { Width = 80, Text = _settings.MaxAttempts.ToString() };
                var txtBudget = new TextBox { Width = 80, Text = _settings.GameBudgetMinutes.ToString() };
                var txtStall = new TextBox { Width = 80, Text = _settings.StalledAfterMinutes.ToString() };

                int r = 0;
                t.Controls.Add(new Label { Text = "模型目录", Height = 26, TextAlign = ContentAlignment.MiddleLeft }, 0, r);
                var dirRow = new FlowLayoutPanel { WrapContents = false, Height = 30 };
                dirRow.Controls.Add(txtDir);
                var bPick = new Button { Text = "…", Width = 30, Height = 24 };
                bPick.Click += (s, e) => { using (var f = new FolderBrowserDialog()) if (f.ShowDialog(dlg) == DialogResult.OK) txtDir.Text = f.SelectedPath; };
                dirRow.Controls.Add(bPick);
                t.Controls.Add(dirRow, 1, r++);

                t.Controls.Add(new Label { Text = "端口", Height = 26, TextAlign = ContentAlignment.MiddleLeft }, 0, r);
                t.Controls.Add(txtPort, 1, r++);
                t.Controls.Add(new Label { Text = "提示词文件", Height = 26, TextAlign = ContentAlignment.MiddleLeft }, 0, r);
                t.Controls.Add(txtPrompt, 1, r++);
                t.Controls.Add(new Label { Text = "管线脚本", Height = 26, TextAlign = ContentAlignment.MiddleLeft }, 0, r);
                var pipeRow = new FlowLayoutPanel { WrapContents = false, Height = 30 };
                pipeRow.Controls.Add(txtPipe);
                var bPipe = new Button { Text = "…", Width = 30, Height = 24 };
                bPipe.Click += (s, e) =>
                {
                    using (var f = new OpenFileDialog { Filter = "JavaScript|*.js|所有文件|*.*" })
                        if (f.ShowDialog(dlg) == DialogResult.OK) txtPipe.Text = f.FileName;
                };
                pipeRow.Controls.Add(bPipe);
                t.Controls.Add(pipeRow, 1, r++);

                t.Controls.Add(new Label { Text = "失败重试次数", Height = 26, TextAlign = ContentAlignment.MiddleLeft }, 0, r);
                t.Controls.Add(txtAttempts, 1, r++);
                t.Controls.Add(new Label { Text = "单游戏时间上限(分)", Height = 26, TextAlign = ContentAlignment.MiddleLeft }, 0, r);
                t.Controls.Add(txtBudget, 1, r++);
                t.Controls.Add(new Label { Text = "无输出判定卡死(分)", Height = 26, TextAlign = ContentAlignment.MiddleLeft }, 0, r);
                t.Controls.Add(txtStall, 1, r++);

                var note = new Label
                {
                    Dock = DockStyle.Bottom, Height = 56, ForeColor = Color.DimGray,
                    Text = "失败重试次数：一个游戏失败几次后跳过它、继续后面的游戏。\n" +
                           "单游戏时间上限 / 无输出判定卡死：超过就结束该游戏并重试，避免整个批次被一个游戏卡住。"
                };

                var ok = new Button { Text = "保存", DialogResult = DialogResult.OK, Width = 80, Height = 28 };
                var cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Width = 80, Height = 28 };
                var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 40, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(0, 6, 12, 0) };
                buttons.Controls.Add(cancel);
                buttons.Controls.Add(ok);

                dlg.Controls.Add(t);
                dlg.Controls.Add(note);
                dlg.Controls.Add(buttons);
                dlg.AcceptButton = ok; dlg.CancelButton = cancel;

                if (dlg.ShowDialog(this) != DialogResult.OK) return;

                int port, attempts, budget, stall;
                if (!int.TryParse(txtPort.Text.Trim(), out port) || port < 1 || port > 65535) { MessageBox.Show(this, "端口无效。"); return; }
                if (!int.TryParse(txtAttempts.Text.Trim(), out attempts) || attempts < 1 || attempts > 10) { MessageBox.Show(this, "重试次数需在 1-10 之间。"); return; }
                if (!int.TryParse(txtBudget.Text.Trim(), out budget) || budget < 5) { MessageBox.Show(this, "时间上限至少 5 分钟。"); return; }
                if (!int.TryParse(txtStall.Text.Trim(), out stall) || stall < 1) { MessageBox.Show(this, "卡死判定至少 1 分钟。"); return; }
                if (txtPipe.Text.Trim().Length > 0 && !File.Exists(txtPipe.Text.Trim())) { MessageBox.Show(this, "管线脚本不存在。"); return; }

                _settings.ModelDir = txtDir.Text.Trim();
                _settings.Port = port;
                _settings.PromptFile = txtPrompt.Text.Trim();
                _settings.PipelineJs = txtPipe.Text.Trim();
                _settings.MaxAttempts = attempts;
                _settings.GameBudgetMinutes = budget;
                _settings.StalledAfterMinutes = stall;
                _settings.Save(_root);

                _runner.Port = port;
                _runner.MaxAttempts = attempts;
                _runner.GameBudget = TimeSpan.FromMinutes(budget);
                _runner.StalledAfter = TimeSpan.FromMinutes(stall);
                if (_settings.PipelineJs.Length > 0) _runner.PipelineJs = _settings.PipelineJs;
                RefreshModels();
                AppendLog("设置已保存。");
            }
        }

        // --------------------------------------------------------------- backup ------

        private void Uninstall() { RunBat("一键还原汉化前.bat", "卸载汉化（还原成日文原版）"); }
        private void Restore() { RunBat("一键恢复汉化.bat", "恢复汉化（切回汉化版）"); }

        private void RunBat(string batName, string what)
        {
            var g = _games.FirstOrDefault(x => x.Checked);
            if (g == null) return;
            string bat = Path.Combine(g.Dir, batName);
            if (!File.Exists(bat))
            {
                MessageBox.Show(this, "该游戏目录没有 " + batName + "。\n\n这个脚本由汉化过程生成；还没汉化过就没有可还原的内容。",
                    "无法执行", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (MessageBox.Show(this, what + "\n\n游戏：" + g.Name + "\n将运行：" + batName + "\n\n确定继续？",
                    "确认", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
            try
            {
                Process.Start(new ProcessStartInfo("cmd.exe")
                {
                    Arguments = "/c " + PipelineRunner.Quote(bat),
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = g.Dir
                });
                AppendLog("已启动 " + batName);
            }
            catch (Exception ex) { AppendLog("执行失败：" + ex.Message); _runner.LogError("执行 " + batName + " 失败：" + ex.Message); }
        }

        // ------------------------------------------------------------------ log ------

        /// <summary>Parse the pipeline's own lines so the panel can show real numbers.</summary>
        private void OnPipelineLine(string line)
        {
            if (InvokeRequired) { BeginInvoke(new Action<string>(OnPipelineLine), line); return; }

            if (line.StartsWith("PROGRESS"))
            {
                // "PROGRESS <done> / <total> REQUESTS <n> FAILURES <m>"
                var m = System.Text.RegularExpressions.Regex.Match(line,
                    @"PROGRESS\s+(\d+)\s*/\s*(\d+)\s+REQUESTS\s+(\d+)\s+FAILURES\s+(\d+)");
                if (m.Success)
                {
                    int done = int.Parse(m.Groups[1].Value);
                    _gameTotal = int.Parse(m.Groups[2].Value);
                    _reqCount = long.Parse(m.Groups[3].Value);
                    _failCount = long.Parse(m.Groups[4].Value);
                    _lastProgressCount = done;
                    _lastProgressAt = DateTime.Now;
                    if (_gameTotal > 0) _barGame.Value = Math.Min(1000, (int)(1000.0 * done / _gameTotal));
                }
                return;   // the panel shows this; echoing every line would bury the log
            }

            if (line.StartsWith("FAILED_ENTRY")) { _failCount++; AppendLog(line); return; }
            if (line.StartsWith("ATTEMPTS_EXHAUSTED")) { _skipCount++; AppendLog(line); return; }
            if (line.StartsWith("LLAMA_TIMINGS")) return;   // one per request: too noisy
            if (line.StartsWith("SKIPPED_ALREADY_TRANSLATED")) { AppendLog(line); return; }

            AppendLog(line);
            if (line.StartsWith("TOTAL")) _status.Text = line;
        }

        private void AppendLog(string line)
        {
            if (_log == null) return;
            if (InvokeRequired) { BeginInvoke(new Action<string>(AppendLog), line); return; }
            if (_log.Lines.Length > 5000)
                _log.Lines = _log.Lines.Skip(_log.Lines.Length - 2500).ToArray();
            _log.AppendText(DateTime.Now.ToString("HH:mm:ss") + "  " + line + Environment.NewLine);
        }

        private void OpenLogFiles()
        {
            try
            {
                Directory.CreateDirectory(_settings.WorkDir);
                Process.Start("explorer.exe", "/select,\"" + Path.Combine(_settings.WorkDir, "errors.log") + "\"");
            }
            catch (Exception ex) { AppendLog("打开目录失败：" + ex.Message); }
        }
    }
}
