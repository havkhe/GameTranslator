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
    /// Main window. Deliberately organised as pages rather than one wall of buttons,
    /// because the v2 window mixed scanning, models, translation and backup into a
    /// single panel of 30+ controls and it was impossible to tell which were safe to
    /// press at any moment.
    ///
    /// Layout rules applied throughout:
    ///   * one page per job (游戏 / 翻译 / 模型 / 备份 / 日志);
    ///   * the toolbar holds only actions that are always safe (扫描、添加、刷新);
    ///   * actions that conflict are never both enabled: 开始 and 终止 share a page and
    ///     are mutually exclusive, as are 暂停 and 继续;
    ///   * anything long-running reports into the 日志 page, so the窗口 never looks
    ///     frozen and a failure is always visible with its reason.
    /// </summary>
    public sealed class MainForm : Form
    {
        private readonly string _root;
        private readonly Settings _settings;
        private readonly PipelineRunner _runner;
        private readonly List<GameItem> _games = new List<GameItem>();

        private TabControl _tabs;
        private ListView _list;
        private TextBox _log;
        private Label _status;
        private ProgressBar _progressBar;

        private Button _btnScan, _btnAdd, _btnRefresh, _btnSelectAll, _btnClearSel;
        private Button _btnStartSel, _btnStartAll, _btnPause, _btnResume, _btnStop;
        private Button _btnCheck, _btnUninstall, _btnRestore, _btnOpenLog;
        private Button _btnLlamaStart, _btnLlamaStop, _btnClearLog;
        private TextBox _txtModelDir, _txtPort, _txtPrompt, _txtAttempts, _txtBudget, _txtStall;
        private CancellationTokenSource _cts;
        private bool _paused;
        private bool _running;

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
            _runner.Output += OnPipelineLine;
            _runner.AttemptFailed += (game, why) => AppendLog("⚠ " + game + "：" + why);

            BuildUi();
            LoadGames();
        }

        // ---------------------------------------------------------------- UI --------

        private void BuildUi()
        {
            Text = "RPG Maker 汉化管理器 v3";
            Size = new Size(1040, 720);
            MinimumSize = new Size(880, 600);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 9f);

            // top toolbar: only always-safe actions
            var toolbar = new FlowLayoutPanel
            {
                Dock = DockStyle.Top, Height = 42, Padding = new Padding(8, 6, 8, 0),
                WrapContents = false, AutoScroll = true
            };
            _btnScan = TbButton("扫描文件夹", (s, e) => ScanFolder());
            _btnAdd = TbButton("添加游戏", (s, e) => AddGame());
            _btnRefresh = TbButton("刷新列表", (s, e) => LoadGames());
            _btnSelectAll = TbButton("全选", (s, e) => SetAllChecked(true));
            _btnClearSel = TbButton("取消全选", (s, e) => SetAllChecked(false));
            toolbar.Controls.AddRange(new Control[] { _btnScan, _btnAdd, _btnRefresh, _btnSelectAll, _btnClearSel });

            // status strip
            var bottom = new Panel { Dock = DockStyle.Bottom, Height = 30 };
            _status = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(10, 0, 0, 0), Text = "就绪" };
            _progressBar = new ProgressBar { Dock = DockStyle.Right, Width = 240, Style = ProgressBarStyle.Continuous };
            bottom.Controls.Add(_status);
            bottom.Controls.Add(_progressBar);

            _tabs = new TabControl { Dock = DockStyle.Fill };
            _tabs.TabPages.Add(BuildTranslatePage());
            _tabs.TabPages.Add(BuildModelPage());
            _tabs.TabPages.Add(BuildBackupPage());
            _tabs.TabPages.Add(BuildLogPage());
            _tabs.SelectedIndexChanged += (s, e) => UpdateButtons();

            Controls.Add(_tabs);
            Controls.Add(toolbar);
            Controls.Add(bottom);
            UpdateButtons();
        }

        private Button TbButton(string text, EventHandler onClick)
        {
            var b = new Button { Text = text, AutoSize = true, Height = 28, Margin = new Padding(0, 0, 6, 0) };
            b.Click += onClick;
            return b;
        }

        private TabPage BuildTranslatePage()
        {
            var page = new TabPage("翻译") { Padding = new Padding(8) };

            // game list
            _list = new ListView
            {
                Dock = DockStyle.Fill,
                View = View.Details,
                CheckBoxes = true,
                FullRowSelect = true,
                GridLines = true
            };
            _list.Columns.Add("", 26);
            _list.Columns.Add("游戏", 380);
            _list.Columns.Add("引擎", 70);
            _list.Columns.Add("条目", 70);
            _list.Columns.Add("进度", 90);
            _list.Columns.Add("状态", 220);

            // Right-click menu: start the game, or open its folder. Both are safe at any
            // time, so they are never disabled — not even while a batch runs.
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
                bool canLaunch = has && !string.IsNullOrEmpty(g.Exe) && File.Exists(g.Exe);
                miLaunch.Enabled = canLaunch;
                miLaunch.Text = canLaunch ? "启动游戏" : "启动游戏（找不到 exe）";
                miOpen.Enabled = has;
                miOpenData.Enabled = has && GetDataDir(g) != null;
                miCopy.Enabled = has;
            };
            _list.ContextMenuStrip = menu;
            // Right-click selects the row under the cursor first, so the menu always acts
            // on the game the user pointed at rather than a stale selection.
            _list.MouseDown += (s, e) =>
            {
                if (e.Button != MouseButtons.Right) return;
                var hit = _list.GetItemAt(e.X, e.Y);
                if (hit != null) { hit.Selected = true; hit.Focused = true; }
            };

            // actions: start and stop are mutually exclusive, so they live together
            var actions = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 44, Padding = new Padding(0, 6, 0, 0), WrapContents = false };
            _btnStartSel = TbButton("开始汉化选中", (s, e) => StartTranslation(false));
            _btnStartAll = TbButton("全部汉化", (s, e) => StartTranslation(true));
            _btnPause = TbButton("暂停", (s, e) => Pause());
            _btnResume = TbButton("继续", (s, e) => Resume());
            _btnStop = TbButton("终止", (s, e) => Stop());
            _btnCheck = TbButton("检查翻译", (s, e) => StartCheck());
            actions.Controls.AddRange(new Control[] { _btnStartSel, _btnStartAll, _btnPause, _btnResume, _btnStop, _btnCheck });

            page.Controls.Add(_list);
            page.Controls.Add(actions);
            return page;
        }

        private TabPage BuildModelPage()
        {
            var page = new TabPage("模型") { Padding = new Padding(12) };
            var table = new TableLayoutPanel { Dock = DockStyle.Top, Height = 260, ColumnCount = 2, AutoSize = true };
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 130));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

            table.Controls.Add(Label("模型目录"), 0, 0);
            _txtModelDir = new TextBox { Dock = DockStyle.Fill, Text = _settings.ModelDir };
            var dirRow = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
            dirRow.Controls.Add(_txtModelDir);
            _txtModelDir.Width = 420;
            var btnPick = TbButton("选择…", (s, e) => PickModelDir());
            dirRow.Controls.Add(btnPick);
            table.Controls.Add(dirRow, 1, 0);

            table.Controls.Add(Label("端口"), 0, 1);
            _txtPort = new TextBox { Width = 80, Text = _settings.Port.ToString() };
            table.Controls.Add(_txtPort, 1, 1);

            table.Controls.Add(Label("提示词文件"), 0, 2);
            _txtPrompt = new TextBox { Width = 420, Text = _settings.PromptFile };
            table.Controls.Add(_txtPrompt, 1, 2);

            table.Controls.Add(Label("失败重试次数"), 0, 3);
            _txtAttempts = new TextBox { Width = 80, Text = _settings.MaxAttempts.ToString() };
            table.Controls.Add(_txtAttempts, 1, 3);

            table.Controls.Add(Label("单游戏时间上限(分)"), 0, 4);
            _txtBudget = new TextBox { Width = 80, Text = _settings.GameBudgetMinutes.ToString() };
            table.Controls.Add(_txtBudget, 1, 4);

            table.Controls.Add(Label("无输出判定卡死(分)"), 0, 5);
            _txtStall = new TextBox { Width = 80, Text = _settings.StalledAfterMinutes.ToString() };
            table.Controls.Add(_txtStall, 1, 5);

            var btns = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 44, Padding = new Padding(0, 10, 0, 0), WrapContents = false };
            _btnLlamaStart = TbButton("启动模型服务", (s, e) => StartLlama());
            _btnLlamaStop = TbButton("停止模型服务", (s, e) => StopLlama());
            var btnSave = TbButton("保存设置", (s, e) => SaveSettings());
            btns.Controls.AddRange(new Control[] { _btnLlamaStart, _btnLlamaStop, btnSave });

            page.Controls.Add(btns);
            page.Controls.Add(table);
            return page;
        }

        private TabPage BuildBackupPage()
        {
            var page = new TabPage("备份 / 还原") { Padding = new Padding(12) };
            var note = new Label
            {
                Dock = DockStyle.Top,
                Height = 90,
                Text = "第一次汉化前会自动把原版数据复制到 data_原版备份，并生成一键还原脚本。\n" +
                       "卸载汉化 = 用备份覆盖现况（还原成日文原版）。\n" +
                       "恢复汉化 = 把汉化版数据放回去。\n\n" +
                       "这两个操作会改写游戏文件，因此只在选中一个游戏时可用，并且会先确认。"
            };
            var btns = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 44, WrapContents = false };
            _btnUninstall = TbButton("卸载汉化（还原原版）", (s, e) => Uninstall());
            _btnRestore = TbButton("恢复汉化（切回汉化版）", (s, e) => Restore());
            btns.Controls.AddRange(new Control[] { _btnUninstall, _btnRestore });
            page.Controls.Add(btns);
            page.Controls.Add(note);
            return page;
        }

        private TabPage BuildLogPage()
        {
            var page = new TabPage("日志 / 错误记录") { Padding = new Padding(8) };
            _log = new TextBox
            {
                Dock = DockStyle.Fill,
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Both,
                WordWrap = false,
                Font = new Font("Consolas", 9f),
                BackColor = Color.FromArgb(250, 250, 250)
            };
            var btns = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 40, WrapContents = false };
            _btnClearLog = TbButton("清空显示", (s, e) => { _log.Clear(); });
            _btnOpenLog = TbButton("打开错误记录文件", (s, e) => OpenLogFiles());
            btns.Controls.AddRange(new Control[] { _btnClearLog, _btnOpenLog });
            page.Controls.Add(_log);
            page.Controls.Add(btns);
            return page;
        }

        private static Label Label(string text)
        {
            return new Label { Text = text, TextAlign = ContentAlignment.MiddleLeft, AutoSize = false, Height = 26, Dock = DockStyle.Fill };
        }

        /// <summary>Enable only the actions that make sense right now.</summary>
        private void UpdateButtons()
        {
            bool running = _running;
            int checkedGames = _games.Count(g => g.Checked);

            _btnStartSel.Enabled = !running && checkedGames > 0;
            _btnStartAll.Enabled = !running && _games.Count > 0;
            _btnStop.Enabled = running;
            _btnPause.Enabled = running && !_paused;
            _btnResume.Enabled = running && _paused;
            _btnCheck.Enabled = !running && checkedGames > 0;

            _btnScan.Enabled = !running;
            _btnAdd.Enabled = !running;
            _btnRefresh.Enabled = !running;
            _btnSelectAll.Enabled = !running;
            _btnClearSel.Enabled = !running;

            _btnLlamaStart.Enabled = !running;
            _btnLlamaStop.Enabled = !running;

            _btnUninstall.Enabled = !running && checkedGames == 1;
            _btnRestore.Enabled = !running && checkedGames == 1;
            _list.Enabled = !running;
        }

        // -------------------------------------------------------------- games ------

        private sealed class GameItem
        {
            public string Dir;
            public string Name;
            public string Engine = "?";
            public int Entries = -1;
            public bool Checked;
            public string Status = "";
            /// <summary>Executable to launch, or null when none was found.</summary>
            public string Exe;
            /// <summary>Folder worth opening in Explorer.</summary>
            public string OpenDir;
            /// <summary>Why launching is not possible, shown to the user instead of failing silently.</summary>
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
                // Resolve lazily here rather than only when a folder is scanned: games
                // restored from games-cache.json have never been through AddOrUpdate, and
                // without this the 启动游戏 context item would stay greyed out for them.
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

        /// <summary>Progress from the pipeline's own report file, so the list never lies.</summary>
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
                double pct = 100.0 * done / entries;
                return done + "/" + entries + " (" + Math.Round(pct) + "%)";
            }
            catch { return ""; }
        }

        private void SetAllChecked(bool value)
        {
            foreach (var g in _games) g.Checked = value;
            foreach (ListViewItem it in _list.Items) it.Checked = value;
            UpdateButtons();
        }

        private void ScanFolder()
        {
            using (var dlg = new FolderBrowserDialog { Description = "选择游戏所在文件夹（会递归查找 Game.exe / Game.rssg3a）" })
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
                    foreach (var sub in SafeDirs(dir))
                    {
                        if (IsGameDir(sub)) { AddOrUpdate(sub); found++; }
                    }
                }
            }
            catch (Exception ex) { AppendLog("扫描出错：" + ex.Message); _runner.LogError("扫描 " + path + " 失败：" + ex.Message); }
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
            var existing = _games.FirstOrDefault(g => string.Equals(g.Dir, dir, StringComparison.OrdinalIgnoreCase));
            if (existing != null) return;
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

        /// <summary>
        /// Work out how to start the game, and record why not when that is impossible.
        ///
        /// Games arrive in two shapes here: an exploded folder with Game.exe, and a bare
        /// archive (Game.rgss3a) whose containing folder may hold no executable at all.
        /// The second case is common in translated releases, so the launch item explains
        /// the situation instead of silently doing nothing.
        /// </summary>
        private static void ResolveLaunchTarget(GameItem g)
        {
            g.OpenDir = g.Dir;
            try
            {
                // Prefer an executable that belongs to the game itself.
                string preferred = Path.Combine(g.Dir, "Game.exe");
                if (File.Exists(preferred)) { g.Exe = preferred; return; }

                var exes = Directory.GetFiles(g.Dir, "*.exe")
                    .Where(f => !IsToolExe(Path.GetFileName(f)))
                    .ToList();
                if (exes.Count > 0)
                {
                    // A translated release often renames the launcher, e.g. "Game_Chinese.exe".
                    g.Exe = exes.FirstOrDefault(f => Path.GetFileName(f).IndexOf("game", StringComparison.OrdinalIgnoreCase) >= 0)
                            ?? exes[0];
                    return;
                }

                g.LaunchProblem = "这个目录里没有可执行文件（.exe），无法从这里启动。\n" +
                                  "它看起来是解包后的数据目录，游戏本体在上一层。\n\n" +
                                  "提示：用「打开所在目录」看一下上层文件夹。";
            }
            catch (Exception ex)
            {
                g.LaunchProblem = "检查可执行文件时出错：" + ex.Message;
            }
        }

        /// <summary>Tool executables that live inside a game folder but are not the game.</summary>
        private static bool IsToolExe(string name)
        {
            var n = name.ToLowerInvariant();
            return n.StartsWith("mtool") || n.StartsWith("nwjs") || n == "nw.exe" ||
                   n.StartsWith("unins") || n.StartsWith("vcredist") ||
                   n.StartsWith("npptools") || n.Contains("translator") ||
                   n.StartsWith("ruby") || n.StartsWith("node") ||
                   n.StartsWith("一键") || n.StartsWith("启动器");
        }

        private void Launch(GameItem g)
        {
            if (g == null) return;
            if (string.IsNullOrEmpty(g.Exe) || !File.Exists(g.Exe))
            {
                MessageBox.Show(this,
                    g.LaunchProblem ?? ("找不到可执行文件：\n" + g.Dir),
                    "无法启动游戏", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            try
            {
                var psi = new ProcessStartInfo(g.Exe)
                {
                    // The working directory must be the game root: RPG Maker resolves
                    // its data, audio and plugin paths relative to it.
                    WorkingDirectory = g.Dir,
                    UseShellExecute = true
                };
                Process.Start(psi);
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
            try
            {
                if (Directory.Exists(dir)) Process.Start("explorer.exe", "/select,\"" + dir + "\"");
                else if (File.Exists(dir)) Process.Start("explorer.exe", "/select,\"" + dir + "\"");
                else MessageBox.Show(this, "目录不存在：\n" + dir, "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                AppendLog("打开目录失败：" + ex.Message);
                _runner.LogError("打开目录 " + dir + " 失败：" + ex.Message);
            }
        }

        /// <summary>The folder holding the engine's data, for either MV/MZ or the VX family.</summary>
        private static string GetDataDir(GameItem g)
        {
            if (g == null) return null;
            string mv = Path.Combine(g.Dir, "www", "data");
            if (Directory.Exists(mv)) return mv;
            string data = Path.Combine(g.Dir, "data");
            if (Directory.Exists(data)) return data;
            return null;
        }

        private void OpenDataDir(GameItem g)
        {
            string dir = GetDataDir(g);
            if (dir == null)
            {
                MessageBox.Show(this, "这个游戏目录里没有 data 文件夹。\n\n" +
                    "如果游戏是打包的（Game.rgss3a / Game.rgss2a），数据在归档内部，需要先解包。",
                    "没有数据目录", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            try { Process.Start("explorer.exe", "/select,\"" + dir + "\""); }
            catch (Exception ex) { AppendLog("打开数据目录失败：" + ex.Message); }
        }

        private void CopyPath(GameItem g)
        {
            if (g == null) return;
            try
            {
                Clipboard.SetText(g.Dir);
                AppendLog("已复制路径：" + g.Dir);
            }
            catch (Exception ex) { AppendLog("复制失败：" + ex.Message); }
        }

        /// <summary>The game the context menu or a single-game action applies to.</summary>
        private GameItem CurrentGame()
        {
            var it = _list != null && _list.SelectedItems.Count > 0 ? _list.SelectedItems[0] : null;
            return it == null ? null : it.Tag as GameItem;
        }

        private static string DetectEngine(string dir)
        {
            try
            {
                string data = Directory.Exists(Path.Combine(dir, "www", "data")) ? Path.Combine(dir, "www", "data") : Path.Combine(dir, "data");
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
                var dir = Path.GetDirectoryName(dlg.FileName);
                AddOrUpdate(dir);
                RefreshList();
            }
        }

        private List<GameItem> Selected(bool all)
        {
            return all ? _games.ToList() : _games.Where(g => g.Checked).ToList();
        }

        // ---------------------------------------------------------- translation -----

        private async void StartTranslation(bool all)
        {
            var list = Selected(all);
            if (list.Count == 0)
            {
                MessageBox.Show(this, "请先勾选要汉化的游戏。", "没有选中游戏", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (all)
            {
                var skip = list.Count(g => g.Status.Contains("跳过"));
                string msg = "将汉化 " + list.Count + " 个游戏。" + (skip > 0 ? "\n其中 " + skip + " 个已标记为中文，会被自动跳过。" : "");
                if (MessageBox.Show(this, msg + "\n\n开始后可以暂停或终止。", "确认", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK)
                    return;
            }

            _running = true; _paused = false;
            _cts = new CancellationTokenSource();
            UpdateButtons();
            _tabs.SelectedIndex = 0;

            var skipped = new List<string>();
            var failed = new List<string>();
            int done = 0;

            foreach (var g in list)
            {
                if (_cts.IsCancellationRequested) break;
                if (g.Status.Contains("跳过"))
                {
                    skipped.Add(g.Name + "（已是中文）");
                    _runner.LogSkip(g.Name + "  已跳过：检测为已是中文");
                    continue;
                }
                // pause gate: the loop checks here, so a pause never interrupts a
                // request mid-flight (which would waste the work already done).
                while (_paused && !_cts.IsCancellationRequested) await Task.Delay(500);
                if (_cts.IsCancellationRequested) break;

                _status.Text = "正在汉化：" + g.Name;
                AppendLog("═══ 开始 " + g.Name + " ═══");
                var outcome = await _runner.RunAsync(g.Dir, _settings.PromptFile, _cts.Token);
                if (outcome.Succeeded) { g.Status = "已完成"; AppendLog("✔ " + g.Name + " 完成（尝试 " + outcome.AttemptsUsed + " 次）"); }
                else if (outcome.SkipReason == "用户终止") { AppendLog("■ 已终止"); break; }
                else { g.Status = "失败已跳过"; failed.Add(g.Name + "：" + outcome.SkipReason); AppendLog("✖ " + g.Name + " 已跳过 —— " + outcome.SkipReason); }
                done++;
                _progressBar.Value = Math.Min(100, (int)(100.0 * done / list.Count));
                RefreshList();
            }

            _running = false;
            _cts = null;
            UpdateButtons();
            _status.Text = "批次结束";

            var sb = new StringBuilder("批次结束。\n完成 " + done + " 个");
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
                catch (Exception ex) { AppendLog("质检失败：" + ex.Message); _runner.LogError("质检 " + g.Name + " 失败：" + ex.Message); }
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

        // -------------------------------------------------------------- llama ------

        private void StartLlama()
        {
            try
            {
                string exe = Path.Combine(_root, "llama", "llama-server.exe");
                if (!File.Exists(exe)) { MessageBox.Show(this, "未找到 " + exe); return; }
                string modelPath = Path.Combine(_settings.ModelDir, _settings.Model);
                if (!File.Exists(modelPath)) { MessageBox.Show(this, "未找到模型文件：\n" + modelPath); return; }
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
                Process.Start(psi);
                AppendLog("已启动模型服务（端口 " + _settings.Port + "）。模型加载需要 30-45 秒，管线会等待。");
                _status.Text = "模型服务启动中…";
            }
            catch (Exception ex) { AppendLog("启动模型服务失败：" + ex.Message); _runner.LogError("启动模型服务失败：" + ex.Message); }
        }

        private void StopLlama()
        {
            // Kill by PID from the executable path, never by bare name: other tools
            // (including the old version) may own a server too.
            int killed = 0;
            foreach (var p in Process.GetProcessesByName("llama-server"))
            {
                try { PipelineRunner.KillTree(p); killed++; } catch { }
            }
            AppendLog("已停止 " + killed + " 个模型服务进程。");
        }

        private void PickModelDir()
        {
            using (var dlg = new FolderBrowserDialog { Description = "选择存放 .gguf 模型的目录" })
            {
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                _txtModelDir.Text = dlg.SelectedPath;
            }
        }

        private void SaveSettings()
        {
            int port, attempts, budget, stall;
            if (!int.TryParse(_txtPort.Text.Trim(), out port) || port < 1 || port > 65535) { MessageBox.Show(this, "端口无效。"); return; }
            if (!int.TryParse(_txtAttempts.Text.Trim(), out attempts) || attempts < 1 || attempts > 10) { MessageBox.Show(this, "重试次数需在 1-10 之间。"); return; }
            if (!int.TryParse(_txtBudget.Text.Trim(), out budget) || budget < 5) { MessageBox.Show(this, "时间上限至少 5 分钟。"); return; }
            if (!int.TryParse(_txtStall.Text.Trim(), out stall) || stall < 1) { MessageBox.Show(this, "卡死判定至少 1 分钟。"); return; }

            _settings.ModelDir = _txtModelDir.Text.Trim();
            _settings.Port = port;
            _settings.PromptFile = _txtPrompt.Text.Trim();
            _settings.MaxAttempts = attempts;
            _settings.GameBudgetMinutes = budget;
            _settings.StalledAfterMinutes = stall;
            _settings.Save(_root);

            _runner.Port = port;
            _runner.MaxAttempts = attempts;
            _runner.GameBudget = TimeSpan.FromMinutes(budget);
            _runner.StalledAfter = TimeSpan.FromMinutes(stall);
            AppendLog("设置已保存。");
        }

        // ------------------------------------------------------------- backup ------

        private void Uninstall() { RunBat("一键还原汉化前.bat", "卸载汉化（还原成日文原版）"); }
        private void Restore() { RunBat("一键恢复汉化.bat", "恢复汉化（切回汉化版）"); }

        private void RunBat(string batName, string what)
        {
            var g = _games.FirstOrDefault(x => x.Checked);
            if (g == null) return;
            string bat = Path.Combine(g.Dir, batName);
            if (!File.Exists(bat))
            {
                MessageBox.Show(this, "该游戏目录没有 " + batName + "。\n\n" +
                    "这个脚本由汉化过程生成；如果还没汉化过，就没有可还原的内容。", "无法执行",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (MessageBox.Show(this, what + "\n\n游戏：" + g.Name + "\n将运行：" + batName + "\n\n确定继续？",
                    "确认", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
            try
            {
                var psi = new ProcessStartInfo("cmd.exe")
                {
                    Arguments = "/c " + PipelineRunner.Quote(bat),
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = g.Dir
                };
                Process.Start(psi);
                AppendLog("已启动 " + batName);
            }
            catch (Exception ex) { AppendLog("执行失败：" + ex.Message); _runner.LogError("执行 " + batName + " 失败：" + ex.Message); }
        }

        // ---------------------------------------------------------------- log ------

        private void OnPipelineLine(string line)
        {
            if (InvokeRequired) { BeginInvoke(new Action<string>(OnPipelineLine), line); return; }
            AppendLog(line);
            if (line.StartsWith("TOTAL")) _status.Text = line;
        }

        private void AppendLog(string line)
        {
            if (_log == null) return;
            if (InvokeRequired) { BeginInvoke(new Action<string>(AppendLog), line); return; }
            if (_log.Lines.Length > 4000)
            {
                var keep = _log.Lines.Skip(_log.Lines.Length - 2000).ToArray();
                _log.Lines = keep;
            }
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
