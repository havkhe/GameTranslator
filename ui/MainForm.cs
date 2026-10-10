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

        private Button _btnScan, _btnAdd, _btnRefresh, _btnRescanAll, _btnSelectAll, _btnClearSel;
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
            Load += OnLoadFix;

            // The one-shot that actually shows the window; see ForceWindowVisible.
            var once = new System.Threading.Timer(_ =>
            {
                try { BeginInvoke(new Action(ForceWindowVisible)); } catch { }
            }, null, 1200, System.Threading.Timeout.Infinite);
            FormClosed += (s, e) => { try { once.Dispose(); } catch { } };
        }

        private void OnLoadFix(object sender, EventArgs e) { ForceWindowVisible(); }

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        private const int SW_SHOWNORMAL = 1;
        private const int SW_SHOW = 5;
        private const int SW_RESTORE = 9;

        /// <summary>
        /// Force the window visible after the message loop is running.
        ///
        /// Diagnosed as "the app starts but no window appears", twice. The facts, from the
        /// form itself: construction succeeds, the native handle is created (2294514),
        /// WindowState is Normal, Opacity 1, ShowInTaskbar true — and Visible is false. The
        /// Load event never fires and neither does a one-shot Timer, so an explicit Show()
        /// and an OnLoad handler both do nothing; whatever prevents the window from being
        /// displayed happens before the message loop begins. Raising the window from outside
        /// with ShowWindow(hwnd, SW_SHOW) does work, verified on a live instance
        /// (visible=False -> visible=True, foreground acquired).
        ///
        /// So the window is shown natively here, by handle, from a timer that starts with the
        /// loop. A timer is used rather than Load precisely because Load never fires; if the
        /// root cause is found later this becomes redundant, not harmful — ShowWindow on an
        /// already-visible window is a no-op.
        /// </summary>
        private void ForceWindowVisible()
        {
            try
            {
                if (!IsHandleCreated) return;
                var h = Handle;
                if (IsWindowVisible(h)) { AppendLog("窗口已可见。"); return; }
                ShowWindow(h, SW_SHOWNORMAL);
                ShowWindow(h, SW_SHOW);
                ShowWindow(h, SW_RESTORE);
                SetForegroundWindow(h);
                AppendLog("已强制显示窗口 (visible=" + IsWindowVisible(h) + ")。");
            }
            catch (Exception ex) { AppendLog("强制显示窗口失败：" + ex.Message); }
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
                if (answer == DialogResult.No)
                {
                    // The task must keep working, so its model server is left running too.
                    AppendLog("窗口关闭，翻译任务继续在后台运行。");
                    return;
                }
                AppendLog("正在停止翻译任务…");
                if (_cts != null) _cts.Cancel();
                _runner.Dispose();      // kill the pipeline and the server it needs
                return;
            }

            // No task running: still release the model server this window started, or it
            // would hold several GB of memory with nothing using it. Dispose only ever
            // stops the server this runner started, by PID.
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
            _btnRefresh = MakeButton("扫描全部路径", (s, e) => ScanAllRoots(false));
            _btnRescanAll = MakeButton("重新扫描全部", (s, e) => RescanAllRoots());
            _btnSelectAll = MakeButton("全选", (s, e) => SetAllChecked(true));
            _btnClearSel = MakeButton("取消全选", (s, e) => SetAllChecked(false));
            bar.Controls.AddRange(new Control[] { _btnScan, _btnAdd, _btnRefresh, _btnRescanAll, _btnSelectAll, _btnClearSel });

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

        /// <summary>
        /// Write the discovered games back to the work folder.
        ///
        /// Without this the scan was forgotten on exit: the list is rebuilt from
        /// games-cache.json at startup, so games found by scanning disappeared the next
        /// time the app opened and the user had to scan again.
        /// </summary>
        private void SaveGamesCache()
        {
            try
            {
                Directory.CreateDirectory(_settings.WorkDir);
                var sb = new StringBuilder();
                sb.Append("[");
                for (int i = 0; i < _games.Count; i++)
                {
                    var g = _games[i];
                    if (i > 0) sb.Append(",");
                    sb.Append("{");
                    sb.Append("\"Dir\":").Append(JsonString(g.Dir)).Append(",");
                    sb.Append("\"Kind\":").Append(JsonString(g.Engine)).Append(",");
                    sb.Append("\"Entries\":").Append(g.Entries >= 0 ? g.Entries : 0);
                    sb.Append("}");
                }
                sb.Append("]");
                File.WriteAllText(Path.Combine(_settings.WorkDir, "games-cache.json"), sb.ToString(), new UTF8Encoding(false));
            }
            catch (Exception ex) { AppendLog("保存游戏列表失败：" + ex.Message); }
        }

        private static string JsonString(string s)
        {
            if (s == null) return "\"\"";
            var sb = new StringBuilder("\"");
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.Append("\"").ToString();
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
            _btnRescanAll.Enabled = !_running;
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
            using (var dlg = new FolderBrowserDialog { Description = "选择游戏所在文件夹（会加进扫描路径列表）" })
            {
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                _settings.AddScanRoot(dlg.SelectedPath);
                _settings.Save(_root);
                ScanPath(dlg.SelectedPath);
            }
        }

        /// <summary>
        /// Scan every remembered root and merge the results into the one list.
        ///
        /// This is the button to use normally: the roots are remembered in settings, the
        /// games are written to games-cache.json, and roots whose games are already known
        /// are skipped so pressing it again does not repeat a minute of walking.
        /// </summary>
        private void ScanAllRoots(bool force)
        {
            var roots = _settings.ScanRoots;
            if (roots.Count == 0)
            {
                MessageBox.Show(this, "还没有设置扫描路径。\n\n点「扫描文件夹」选择一个，之后它会一直被记住。",
                    "没有扫描路径", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            var known = new HashSet<string>(_games.Select(g => g.Dir), StringComparer.OrdinalIgnoreCase);
            int before = _games.Count;
            int scanned = 0, skipped = 0;

            foreach (var root in roots)
            {
                if (!Directory.Exists(root))
                {
                    AppendLog("跳过不存在的扫描路径：" + root);
                    continue;
                }
                // A root already covered by the remembered games needs no rescan unless
                // asked. "Covered" means its record exists and nothing there is new, which
                // is checked cheaply by counting the games we already hold under it.
                var under = _games.Count(g => g.Dir.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase));
                if (!force && under > 0)
                {
                    skipped++;
                    AppendLog("已扫描过，跳过：" + root + "（" + under + " 个游戏）");
                    continue;
                }
                scanned++;
                ScanPath(root, quiet: roots.Count > 1);
            }

            SaveGamesCache();
            RefreshList();
            var added = _games.Count - before;
            _status.Text = "扫描完成：扫描 " + scanned + " 个路径，跳过 " + skipped + " 个已扫描路径，新增 " + added +
                " 个游戏，列表共 " + _games.Count + " 个";
            AppendLog(_status.Text);
            if (added == 0 && !force)
                AppendLog("提示：没有新增游戏。如果游戏位置有变动，可用「重新扫描全部」强制重扫。");
        }

        /// <summary>Ask for the depth, then scan every root from scratch.</summary>
        private void RescanAllRoots()
        {
            var roots = _settings.ScanRoots;
            if (roots.Count == 0) { ScanAllRoots(true); return; }
            if (MessageBox.Show(this,
                    "重新扫描全部路径会清空当前列表并从头查找 " + roots.Count + " 个路径。\n\n" +
                    "当前扫描深度：" + _settings.ScanDepth + " 层\n" +
                    "（可在「设置…」里调整深度）\n\n继续？",
                    "重新扫描", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            _games.Clear();
            ScanAllRoots(true);
        }

        /// <summary>How deep to look, from settings. 1 means the root's children only.</summary>
        private int MaxScanDepth { get { return Math.Max(1, _settings.ScanDepth); } }

        /// <summary>Children never worth descending into: they are data, not games.</summary>
        private static bool IsBoringDir(string name)
        {
            var n = name.ToLowerInvariant();
            if (n.StartsWith(".")) return true;
            switch (n)
            {
                case "node_modules": case "system volume information": case "$recycle.bin":
                case "windows": case "program files": case "program files (x86)":
                case "appdata": case "temp": case "tmp": case "cache": case "obj":
                    return true;
            }
            // Translation work folders and backups only ever contain copies of a game.
            if (n.Contains("バックアップ") || n.Contains("备份") || n.Contains("備份")) return true;
            if (n.StartsWith("data_")) return true;
            if (n.EndsWith("_orig") || n.EndsWith("_bak")) return true;
            return false;
        }

        /// <summary>
        /// Walk one root and add every game found.
        ///
        /// Iterative with an explicit queue, so a deep tree cannot overflow the stack, and
        /// bounded by MaxScanDepth so picking a drive root cannot become a full-disk crawl.
        /// Unreadable directories are skipped rather than aborting the scan; libraries on a
        /// network drive always contain some.
        /// </summary>
        private void ScanPath(string path) { ScanPath(path, false); }

        private void ScanPath(string path, bool quiet)
        {
            if (!quiet) AppendLog("开始扫描 " + path + "（最多 " + MaxScanDepth + " 层）…");
            _status.Text = "正在扫描 " + path + " …";
            var found = new List<string>();
            int visited = 0;
            var started = DateTime.Now;

            var queue = new Queue<KeyValuePair<string, int>>();
            queue.Enqueue(new KeyValuePair<string, int>(path, 0));
            try
            {
                while (queue.Count > 0)
                {
                    var item = queue.Dequeue();
                    var dir = item.Key;
                    var depth = item.Value;
                    visited++;
                    if (visited % 200 == 0)
                    {
                        _status.Text = "正在扫描… 已检查 " + visited + " 个目录，找到 " + found.Count + " 个游戏（" +
                            Math.Round((DateTime.Now - started).TotalSeconds) + " 秒）";
                        Application.DoEvents();
                    }

                    if (IsGameDir(dir)) found.Add(dir);
                    if (depth >= MaxScanDepth) continue;

                    IEnumerable<string> subs;
                    try { subs = Directory.EnumerateDirectories(dir); }
                    catch { continue; }
                    foreach (var sub in subs)
                    {
                        if (IsBoringDir(Path.GetFileName(sub))) continue;
                        queue.Enqueue(new KeyValuePair<string, int>(sub, depth + 1));
                    }
                }
            }
            catch (Exception ex)
            {
                AppendLog("扫描出错：" + ex.Message);
                _runner.LogError("扫描 " + path + " 失败：" + ex.Message);
            }

            foreach (var dir in found) AddOrUpdate(dir);
            var secs = Math.Round((DateTime.Now - started).TotalSeconds, 1);
            AppendLog("  " + path + " → 检查 " + visited + " 个目录，找到 " + found.Count + " 个游戏，用时 " + secs + " 秒");
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
                string exe = Path.Combine(_settings.LlamaDir ?? "", "llama-server.exe");
                if (!File.Exists(exe))
                {
                    // Name the path that was tried and what to do about it; "not found" on
                    // its own gives the user nothing to act on.
                    MessageBox.Show(this,
                        "未找到 llama-server.exe。\n\n" +
                        "查找位置：\n" + exe + "\n\n" +
                        "请在「设置…」里把「llama 目录」指向包含 llama-server.exe 的文件夹。\n\n" +
                        "旧版（v2）通常在：\nD:\\GameTranslator\\llama",
                        "未找到模型运行程序", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
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
                dlg.Size = new Size(660, 560);
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
                var txtDepth = new TextBox { Width = 60, Text = _settings.ScanDepth.ToString() };
                var txtLlama = new TextBox { Width = 380, Text = _settings.LlamaDir };

                // Scan-root editor: a list plus add/remove, so several folders can feed the
                // same game list.
                var rootList = new ListBox { Width = 380, Height = 78 };
                var roots = _settings.ScanRoots;
                foreach (var x in roots) rootList.Items.Add(x);
                var rootPanel = new FlowLayoutPanel { WrapContents = false, Height = 82, AutoSize = false };
                var rootButtons = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, Width = 74, Height = 80 };
                var bAddRoot = new Button { Text = "添加…", Width = 70, Height = 24 };
                var bDelRoot = new Button { Text = "移除", Width = 70, Height = 24 };
                bAddRoot.Click += (s, e) =>
                {
                    using (var f = new FolderBrowserDialog { Description = "选择要扫描的游戏文件夹" })
                        if (f.ShowDialog(dlg) == DialogResult.OK && !rootList.Items.Contains(f.SelectedPath))
                            rootList.Items.Add(f.SelectedPath);
                };
                bDelRoot.Click += (s, e) => { if (rootList.SelectedIndex >= 0) rootList.Items.RemoveAt(rootList.SelectedIndex); };
                rootButtons.Controls.Add(bAddRoot);
                rootButtons.Controls.Add(bDelRoot);
                rootPanel.Controls.Add(rootList);
                rootPanel.Controls.Add(rootButtons);

                int r = 0;
                t.Controls.Add(new Label { Text = "模型目录", Height = 26, TextAlign = ContentAlignment.MiddleLeft }, 0, r);
                var dirRow = new FlowLayoutPanel { WrapContents = false, Height = 30 };
                dirRow.Controls.Add(txtDir);
                var bPick = new Button { Text = "…", Width = 30, Height = 24 };
                bPick.Click += (s, e) => { using (var f = new FolderBrowserDialog()) if (f.ShowDialog(dlg) == DialogResult.OK) txtDir.Text = f.SelectedPath; };
                dirRow.Controls.Add(bPick);
                t.Controls.Add(dirRow, 1, r++);

                t.Controls.Add(new Label { Text = "llama 目录", Height = 26, TextAlign = ContentAlignment.MiddleLeft }, 0, r);
                var llamaRow = new FlowLayoutPanel { WrapContents = false, Height = 30 };
                llamaRow.Controls.Add(txtLlama);
                var bPickLlama = new Button { Text = "…", Width = 30, Height = 24 };
                bPickLlama.Click += (s, e) =>
                {
                    using (var fb = new FolderBrowserDialog { Description = "选择包含 llama-server.exe 的文件夹" })
                        if (fb.ShowDialog(dlg) == DialogResult.OK) txtLlama.Text = fb.SelectedPath;
                };
                llamaRow.Controls.Add(bPickLlama);
                t.Controls.Add(llamaRow, 1, r++);

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

                // Scan roots and depth. Several roots are merged into the one list, and the
                // roots are remembered so the library is not re-found on every launch.
                t.Controls.Add(new Label { Text = "扫描深度(层)", Height = 26, TextAlign = ContentAlignment.MiddleLeft }, 0, r);
                var depthRow = new FlowLayoutPanel { WrapContents = false, Height = 30 };
                depthRow.Controls.Add(txtDepth);
                depthRow.Controls.Add(new Label
                {
                    Text = "  4 层约 1 分钟；调大可找到嵌套在游戏文件夹里的游戏，但更慢",
                    AutoSize = true, ForeColor = Color.DimGray
                });
                t.Controls.Add(depthRow, 1, r++);

                t.Controls.Add(new Label { Text = "扫描路径", Height = 26, TextAlign = ContentAlignment.MiddleLeft }, 0, r);
                t.Controls.Add(rootPanel, 1, r++);

                var note = new Label
                {
                    Dock = DockStyle.Bottom, Height = 56, ForeColor = Color.DimGray,
                    Text = "失败重试次数：一个游戏失败几次后跳过它、继续后面的游戏。\n" +
                           "单游戏时间上限 / 无输出判定卡死：超过就结束该游戏并重试，避免整个批次被一个游戏卡住。\n" +
                           "扫描路径：可添加多个文件夹，结果汇总在同一个列表里；路径会被记住，下次无需重新扫描。"
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

                string llama = txtLlama.Text.Trim();
                if (llama.Length > 0 && !File.Exists(Path.Combine(llama, "llama-server.exe")))
                {
                    if (MessageBox.Show(this, "这个目录里没有 llama-server.exe：\n" + llama + "\n\n仍要保存吗？",
                            "确认", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
                }
                _settings.LlamaDir = llama;
                _settings.ModelDir = txtDir.Text.Trim();
                _settings.Port = port;
                _settings.PromptFile = txtPrompt.Text.Trim();
                _settings.PipelineJs = txtPipe.Text.Trim();
                _settings.MaxAttempts = attempts;
                _settings.GameBudgetMinutes = budget;
                _settings.StalledAfterMinutes = stall;

                int depth;
                if (!int.TryParse(txtDepth.Text.Trim(), out depth) || depth < 1 || depth > 12)
                { MessageBox.Show(this, "扫描深度需在 1-12 之间。"); return; }
                _settings.ScanDepth = depth;

                var rootList2 = new List<string>();
                foreach (var o in rootList.Items) rootList2.Add(Convert.ToString(o));
                _settings.ScanRoots = rootList2;

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
