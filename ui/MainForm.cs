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

        private Button _btnScan, _btnAdd, _btnRefresh, _btnRescanAll, _btnState, _btnSelectAll, _btnClearSel;
        private Button _btnStartSel, _btnStartAll, _btnPause, _btnResume, _btnStop, _btnCheck;
        private Button _btnUninstall, _btnRestore, _btnOpenLog, _btnClearLog, _btnSettings;

        // ---- 翻译对照 ------------------------------------------------------------------------
        //
        // Shows the pair the run just produced: the source above, the translation below, and the recent
        // pairs in a list for reference. Session only — nothing here is written to disk, and a pair is
        // shown only when this run actually produced it (a run served from the cache displays nothing,
        // which is the honest signal that it translated nothing new).
        private TextBox _pairSrc, _pairDst;
        private ListView _pairList;
        private CheckBox _chkPairAuto;
        private Label _lblPairCount;
        private long _pairCount;
        private const int PairHistoryMax = 200;

        // ---- 速度与预计 ----------------------------------------------------------------------
        //
        // Both figures are SAMPLED over a window instead of read instantaneously: the counters move in
        // bursts (one reply every few seconds), so an instantaneous reading swings wildly and the estimate
        // built on it would too. Every window the rate is recomputed from the deltas and the baseline moves.
        private Label _lblEta;
        /// <summary>Last /metrics reading of predicted tokens, and when it was taken.</summary>
        private long _serverTokens = -1;
        private DateTime _serverTokensAt = DateTime.MinValue;
        private DateTime _rateSampleAt = DateTime.MinValue;
        private long _rateSampleTokens;
        private int _rateSampleEntries;
        private double _tokPerSec, _entriesPerMin;
        /// <summary>The sampling window, in seconds.</summary>
        private const int RateWindowSeconds = 15;
        /// <summary>Games of the current run that have not finished yet, for the batch estimate.</summary>
        private List<GameItem> _runGames = new List<GameItem>();
        /// <summary>Entries already translated by the games of this run that have finished.</summary>
        private int _runEntriesBase;
        /// <summary>The game being translated now, so the estimate does not count it twice.</summary>
        private GameItem _currentItem;

        // ---- grouped translation queue -------------------------------------------------------
        //
        // The one-shot batch above and this queue are separate paths on purpose: the old buttons keep
        // working exactly as before, and the queue adds what they cannot do — run several groups one
        // after another, show which group is running, and accept more tasks while a run is in flight.
        // The queue only ever writes work\queue.json; game data and every pipeline cache file are
        // touched by nothing here.
        private readonly List<TaskGroup> _queue = new List<TaskGroup>();
        private int _queueGroupIndex = -1;      // group being run, or -1
        private int _queueTaskIndex = -1;       // task within that group
        private bool _skipGroupRequested;       // 跳过本组
        private TreeView _queueTree;
        private Label _lblQueue;
        private ComboBox _cmbTargetGroup;
        private Button _btnNewGroupAddSel, _btnAddSelToGroup, _btnRemoveSel, _btnClearQueue, _btnSkipGroup, _btnStartQueue;
        private CancellationTokenSource _cts;
        private bool _paused, _running;
        /// <summary>True while 检查翻译 runs — it is synchronous, so pause/resume cannot act.</summary>
        private bool _checking;
        private ToolTip _tips;

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

            // Timing, so a slow start can be attributed instead of guessed. Reported once at the end
            // of construction and written to the same startup trace the launcher uses.
            var sw = System.Diagnostics.Stopwatch.StartNew();
            long tUi, tModels, tGames;
            BuildUi(); tUi = sw.ElapsedMilliseconds;
            RefreshModels(); tModels = sw.ElapsedMilliseconds - tUi;
            LoadGames(); tGames = sw.ElapsedMilliseconds - tUi - tModels;
            // The queue is restored after the UI and after the game list, so the panel exists to draw
            // into and a queued task can be matched to its GameItem right away. Only work\queue.json is
            // read here; no game data and no pipeline cache file is touched.
            LoadQueue();
            RefreshQueuePanel();
            Startup.Trace("MainForm 内部耗时：界面 " + tUi + "ms，模型列表 " + tModels + "ms，游戏列表 " +
                tGames + "ms（" + _games.Count + " 个游戏）");

            _ticker = new System.Windows.Forms.Timer { Interval = 1000 };
            _ticker.Tick += (s, e) => UpdateProgressPanel();
            _ticker.Start();

            FormClosing += OnFormClosing;

            // One nudge, on this thread, a moment after the loop is up.
            //
            // This used to be a System.Threading.Timer whose callback called BeginInvoke from a
            // thread-pool thread. That is what kept the window invisible: Application.Run sets
            // Visible and, before the loop reaches its first pump, the pool thread's BeginInvoke
            // marshals onto the same window and the two wait on each other — no Load, no Shown, no
            // timer tick ever reached the form, which is exactly what the launch trace showed. A
            // WinForms timer runs on the UI thread, so it cannot race the pump that feeds it.
            var nudge = new System.Windows.Forms.Timer { Interval = 700 };
            nudge.Tick += (s, e) => { nudge.Stop(); ForceWindowVisible(); };
            nudge.Start();
            FormClosed += (s, e) => { try { nudge.Dispose(); } catch { } };
        }

        // The window now shows itself: the show path costs milliseconds once the game list is filled
        // in virtual mode, so the Load event fires normally and neither a native ShowWindow nor a
        // retry thread is needed to make the window appear. OnShown is kept only to record when it
        // happened, which is the figure the launch trace is read for.

        protected override void OnShown(EventArgs e)
        {
            Startup.Trace("窗口已显示");
            base.OnShown(e);
        }

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
                if (!IsHandleCreated) { Startup.Trace("ForceWindowVisible: 尚无句柄"); return; }
                var h = Handle;
                if (IsWindowVisible(h)) { Startup.Trace("窗口已可见"); AppendLog("窗口已可见。"); return; }
                ShowWindow(h, SW_SHOWNORMAL);
                ShowWindow(h, SW_SHOW);
                ShowWindow(h, SW_RESTORE);
                SetForegroundWindow(h);
                Startup.Trace("已强制显示窗口 visible=" + IsWindowVisible(h));
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
            TipRunLockedButtons();
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
            _btnState = MakeButton("刷新状态", (s, e) => RefreshGameStates());
            _btnSelectAll = MakeButton("全选", (s, e) => SetAllChecked(true));
            _btnClearSel = MakeButton("取消全选", (s, e) => SetAllChecked(false));
            bar.Controls.AddRange(new Control[] { _btnScan, _btnAdd, _btnRefresh, _btnRescanAll, _btnState, _btnSelectAll, _btnClearSel });

            _list = new GameListView
            {
                Dock = DockStyle.Fill, View = View.Details,
                // CheckBoxes is off and the check is drawn as a character in the first column.
                //
                // The native box is a themed glyph the control draws from its own state image, and on
                // this machine at 200 % display scaling it renders as nothing at all: the control still
                // reports LVS_EX_CHECKBOXES and a 26 px first column, but the user sees no box and has
                // nothing to aim at. A character cannot fail to draw, and clicking anywhere on the row
                // toggles it, so there is no 16 px target to hit either.
                CheckBoxes = false,
                FullRowSelect = true, GridLines = true, HideSelection = false,
                // Virtual mode: rows are produced on demand instead of being pushed into the native
                // control. Adding a row to a real ListView costs about 300 ms on the machine this was
                // measured on (110 rows: 34 s; 10 rows: 3 s — linear), and that cost is paid when the
                // row reaches the control, i.e. during the show if the list was filled before it, or
                // on the UI thread for half a minute if it was filled after. Virtual mode pays none
                // of it, so the window appears at once and stays responsive whatever the list length.
                VirtualMode = true,
                // Rows carry their full text as a tooltip: a column is always narrower than a game
                // name plus its state note, so hovering is how the rest is read.
                ShowItemToolTips = true
            };
            _list.RetrieveVirtualItem += (s, e) =>
            {
                if (e.ItemIndex >= 0 && e.ItemIndex < _games.Count) e.Item = MakeRow(_games[e.ItemIndex]);
            };
            _list.Columns.Add("选", 34);             // 0  the check character
            _list.Columns.Add("游戏", 300);          // 1  game name (absorbs the slack)
            _list.Columns.Add("引擎", 60);           // 2  engine
            _list.Columns.Add("进度", 150);          // 3  progress
            _list.Columns.Add("状态", 170);          // 4  state
            // Columns are sized to the pane, not to the window. At 200 % display scaling the pane is
            // narrower than the fixed widths added up, and that is what cut the 状态 text off
            // ("未汉化（已还原）（有原…"). The name column absorbs whatever is left, and 条目 moved
            // into 进度 so there is room for the state.
            _list.Resize += (s, e) => ApplyColumnWidths();
            // One click anywhere on a row toggles whether that game runs. Two paths are wired to the
            // same action on purpose: the native WM_LBUTTONUP (see GameListView) and WinForms' own
            // MouseUp. Whichever the platform delivers, the row toggles — and no path depends on
            // hitting the 16 px box, which is what made this feel unresponsive before.
            ((GameListView)_list).RowClicked += ToggleRow;
            _list.MouseUp += (s, e) =>
            {
                if (e.Button != MouseButtons.Left) return;
                var hit = _list.HitTest(e.Location);
                if (hit != null && hit.Item != null) ToggleRow(hit.Item.Index);
            };
            _list.KeyDown += (s, e) =>
            {
                if (e.KeyCode == Keys.Space) { ToggleRows(_list.SelectedIndices); e.Handled = true; }
            };
            _list.SelectedIndexChanged += (s, e) => UpdateButtons();
            AttachGameContextMenu();
            Tip(_list, "单击一行即可勾选/取消勾选（空格键同效）。\n右键：启动游戏 / 打开目录 / 打开数据目录 / 复制路径。\n翻译进行中也能这样操作：取消勾选的游戏不会被开始。");

            var pane = new Panel { Dock = DockStyle.Fill };
            pane.Controls.Add(_list);
            // The task controls and the log live here rather than in the right column: on the right
            // every pixel they took came out of the 翻译对照 panel, which is the one area that has to
            // be big (it is the only place the running translation can be read). Docking is resolved
            // backwards through the collection, so adding them after the list puts them below it:
            // 任务队列 / 工具栏 / 游戏列表 / 任务控制 / 日志.
            pane.Controls.Add(BuildTaskControlBox());
            pane.Controls.Add(BuildLogBox());
            pane.Controls.Add(bar);
            // Added last, and docking is resolved from the end of the collection backwards, so this
            // reserves the top strip above the toolbar: 任务队列 / 工具栏 / 游戏列表.
            pane.Controls.Add(BuildQueuePane());
            return pane;
        }

        /// <summary>
        /// The grouped queue panel: the groups and their members on top, the buttons that build and run
        /// them at the bottom.
        ///
        /// A TreeView rather than a second ListView: the game list is a ListView and the UI check asserts
        /// there is exactly one (in virtual mode), and a tree is the natural control for "groups that
        /// expand into their members".
        /// </summary>
        private Control BuildQueuePane()
        {
            var box = new GroupBox { Dock = DockStyle.Top, Height = 196, Text = "任务队列（按组顺序执行）" };

            _queueTree = new TreeView
            {
                Dock = DockStyle.Fill, HideSelection = false, ShowNodeToolTips = true,
                ShowPlusMinus = true, ShowRootLines = true, BorderStyle = BorderStyle.FixedSingle
            };

            // Summary line plus the group the 加入 button targets.
            var top = new TableLayoutPanel
            {
                Dock = DockStyle.Top, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
                ColumnCount = 2, Padding = new Padding(6, 2, 6, 0)
            };
            top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
            top.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            _lblQueue = new Label
            {
                Dock = DockStyle.Fill, AutoSize = false, Height = 18,
                TextAlign = ContentAlignment.MiddleLeft, Text = "队列：空"
            };
            _cmbTargetGroup = new ComboBox
            {
                Name = "cmbTargetGroup",
                Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList,
                Width = 132, Margin = new Padding(2, 0, 0, 0)
            };
            top.Controls.Add(_lblQueue, 0, 0);
            top.Controls.Add(_cmbTargetGroup, 1, 0);

            var btns = MakeButtonGrid(3);
            btns.Dock = DockStyle.Bottom;
            _btnNewGroupAddSel = MakeButton("新建组并加入选中", (s, e) => AddCheckedToNewGroup());
            _btnAddSelToGroup = MakeButton("加入选中到所选组", (s, e) => AddCheckedToSelectedGroup());
            _btnRemoveSel = MakeButton("移出选中", (s, e) => RemoveCheckedFromQueue());
            _btnClearQueue = MakeButton("清空队列", (s, e) => ClearQueue());
            _btnSkipGroup = MakeButton("跳过本组", (s, e) => SkipCurrentGroup());
            _btnStartQueue = MakeButton("开始队列", (s, e) => RunQueue());
            AddToGrid(btns, _btnNewGroupAddSel, _btnAddSelToGroup, _btnRemoveSel,
                _btnClearQueue, _btnSkipGroup, _btnStartQueue);

            box.Controls.Add(_queueTree);   // Fill
            box.Controls.Add(btns);         // Bottom
            box.Controls.Add(top);          // Top
            return box;
        }

        // ------------------------------------------------------------- queue model --

        private int QueueTaskCount()
        {
            int n = 0;
            foreach (var g in _queue) n += g.Tasks.Count;
            return n;
        }

        /// <summary>Case- and trailing-separator-insensitive directory comparison.</summary>
        private static bool SameDir(string a, string b)
        {
            return string.Equals((a ?? "").TrimEnd('\\', '/'), (b ?? "").TrimEnd('\\', '/'),
                StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>The queue entry for a game, with the group holding it, or null.</summary>
        private Tuple<QueueTask, TaskGroup> FindTask(string dir)
        {
            foreach (var grp in _queue)
                foreach (var t in grp.Tasks)
                    if (SameDir(t.Dir, dir)) return Tuple.Create(t, grp);
            return null;
        }

        /// <summary>Add games to a group, creating the group when it is new. One game lives in one group.</summary>
        private void AddTasks(TaskGroup grp, List<GameItem> games)
        {
            if (games == null || games.Count == 0) return;
            if (!_queue.Contains(grp)) _queue.Add(grp);
            int added = 0, moved = 0;
            foreach (var g in games)
            {
                var at = FindTask(g.Dir);
                if (at != null)
                {
                    if (ReferenceEquals(at.Item2, grp)) continue;     // already here
                    at.Item2.Tasks.Remove(at.Item1);                  // move it to the requested group
                    moved++;
                }
                grp.Tasks.Add(new QueueTask { Dir = g.Dir, Name = g.Name });
                added++;
            }
            DropEmptyGroups();
            SaveQueue();
            RefreshQueuePanel();
            UpdateButtons();
            AppendLog("队列：加入 " + added + " 个任务" + (moved > 0 ? "，移动 " + moved + " 个" : "") +
                "；现有 " + _queue.Count + " 组 / " + QueueTaskCount() + " 个任务");
        }

        private List<GameItem> CheckedGames()
        {
            return _games.Where(g => g.Checked).ToList();
        }

        private void AddCheckedToNewGroup()
        {
            var sel = CheckedGames();
            if (sel.Count == 0)
            {
                MessageBox.Show(this, "请先在列表里勾选要加入队列的游戏。", "没有选中游戏",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            AddTasks(new TaskGroup(), sel);
        }

        private void AddCheckedToSelectedGroup()
        {
            var sel = CheckedGames();
            if (sel.Count == 0)
            {
                MessageBox.Show(this, "请先在列表里勾选要加入队列的游戏。", "没有选中游戏",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (_queue.Count == 0) { AddTasks(new TaskGroup(), sel); return; }
            int gi = _cmbTargetGroup.SelectedIndex;
            if (gi < 0 || gi >= _queue.Count) gi = _queue.Count - 1;
            AddTasks(_queue[gi], sel);
        }

        private void RemoveCheckedFromQueue()
        {
            var sel = CheckedGames();
            if (sel.Count == 0 || _queue.Count == 0) return;
            int removed = 0;
            foreach (var g in sel)
            {
                var at = FindTask(g.Dir);
                if (at == null) continue;
                at.Item2.Tasks.Remove(at.Item1);
                removed++;
            }
            if (removed == 0) return;
            DropEmptyGroups();
            SaveQueue();
            RefreshQueuePanel();
            UpdateButtons();
            AppendLog("队列：移出 " + removed + " 个任务；现有 " + _queue.Count + " 组 / " + QueueTaskCount() + " 个任务");
        }

        private void ClearQueue()
        {
            if (_queue.Count == 0) return;
            if (MessageBox.Show(this, "确定清空整个队列（" + _queue.Count + " 组 / " + QueueTaskCount() + " 个任务）？\n\n" +
                    "只清空队列本身，已翻译的成果与游戏数据都不受影响。",
                    "清空队列", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            _queue.Clear();
            SaveQueue();
            RefreshQueuePanel();
            UpdateButtons();
            AppendLog("队列：已清空");
        }

        /// <summary>Groups with no tasks left disappear, so the numbering stays dense.</summary>
        private void DropEmptyGroups()
        {
            for (int i = _queue.Count - 1; i >= 0; i--)
                if (_queue[i].Tasks.Count == 0) { _queue.RemoveAt(i); if (_queueGroupIndex >= i) _queueGroupIndex = -1; }
        }

        private void SkipCurrentGroup()
        {
            if (!_running) return;
            _skipGroupRequested = true;
            AppendLog("⤼ 跳过本组：当前这个游戏跑完就进下一组");
        }

        /// <summary>Redraw the group tree, the summary line and the target-group list.</summary>
        private void RefreshQueuePanel()
        {
            if (_queueTree == null || _lblQueue == null) return;
            _queueTree.BeginUpdate();
            _queueTree.Nodes.Clear();
            for (int gi = 0; gi < _queue.Count; gi++)
            {
                var grp = _queue[gi];
                int done = grp.Tasks.Count(t => t.Result == "完成");
                string state = (_running && gi == _queueGroupIndex) ? "运行中" : grp.State;
                var node = new TreeNode("第 " + (gi + 1) + " 组　[" + state + " " + done + "/" + grp.Tasks.Count + "]")
                {
                    Tag = gi,
                    ToolTipText = "第 " + (gi + 1) + " 组：" + state + "，共 " + grp.Tasks.Count + " 个任务"
                };
                for (int ti = 0; ti < grp.Tasks.Count; ti++)
                {
                    var t = grp.Tasks[ti];
                    string mark;
                    if (t.Result == "完成") mark = "✔";
                    else if (t.Result == "失败") mark = "✖";
                    else if (t.Result == "跳过") mark = "⤼";
                    else if (t.Result == "取消") mark = "■";
                    else mark = (_running && gi == _queueGroupIndex && ti == _queueTaskIndex) ? "▶" : "·";
                    string tail = t.Result.Length > 0 ? t.Result : (t.Note.Length > 0 ? t.Note : "等待");
                    node.Nodes.Add(new TreeNode(mark + " " + t.Name + " — " + tail)
                    {
                        Tag = t,
                        ToolTipText = t.Dir + (t.Note.Length > 0 ? "\n" + t.Note : "")
                    });
                }
                if (grp.Tasks.Count <= 12 || gi == _queueGroupIndex) node.Expand();
                _queueTree.Nodes.Add(node);
            }
            _queueTree.EndUpdate();

            var sb = new StringBuilder();
            sb.Append(_queue.Count == 0
                ? "队列：空（勾选游戏后点「新建组并加入选中」）"
                : "队列：" + _queue.Count + " 组 / " + QueueTaskCount() + " 个任务");
            if (_running && _queueGroupIndex >= 0 && _queueGroupIndex < _queue.Count)
            {
                var grp = _queue[_queueGroupIndex];
                sb.Append("　当前：第 " + (_queueGroupIndex + 1) + " 组（" +
                    (_queueTaskIndex >= 0 ? _queueTaskIndex + 1 : 0) + "/" + grp.Tasks.Count + "）");
            }
            else if (_queue.Count > 0) sb.Append("　未开始");
            _lblQueue.Text = sb.ToString();

            int want = _cmbTargetGroup.SelectedIndex;
            _cmbTargetGroup.Items.Clear();
            for (int i = 0; i < _queue.Count; i++)
                _cmbTargetGroup.Items.Add("第 " + (i + 1) + " 组（" + _queue[i].Tasks.Count + " 个）");
            if (_cmbTargetGroup.Items.Count > 0)
                _cmbTargetGroup.SelectedIndex =
                    (want >= 0 && want < _cmbTargetGroup.Items.Count) ? want : _cmbTargetGroup.Items.Count - 1;
        }

        // --------------------------------------------------------- queue persistence --

        private string QueuePath
        {
            get { return Path.Combine(_settings.WorkDir, "queue.json"); }
        }

        /// <summary>
        /// Write the queue. This is the only file the queue writes — game data, the scan cache and the
        /// pipeline's own per-game cache files are never touched from here.
        ///
        /// The shape is a flat array of one row per task, with the group's state repeated on each row,
        /// because SimpleJson only reads a top-level array of flat objects. A group with no tasks
        /// therefore cannot be represented, which is why creating a group requires a selected game.
        /// </summary>
        private void SaveQueue(string path = null)
        {
            try
            {
                var target = path ?? QueuePath;
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                var sb = new StringBuilder("[");
                for (int gi = 0; gi < _queue.Count; gi++)
                {
                    var grp = _queue[gi];
                    for (int ti = 0; ti < grp.Tasks.Count; ti++)
                    {
                        var t = grp.Tasks[ti];
                        if (sb.Length > 1) sb.Append(",");
                        sb.Append("{");
                        sb.Append("\"Group\":").Append(gi + 1).Append(",");
                        sb.Append("\"GroupState\":").Append(JsonString(grp.State)).Append(",");
                        sb.Append("\"Ord\":").Append(ti).Append(",");
                        sb.Append("\"Dir\":").Append(JsonString(t.Dir)).Append(",");
                        sb.Append("\"Name\":").Append(JsonString(t.Name)).Append(",");
                        sb.Append("\"Result\":").Append(JsonString(t.Result)).Append(",");
                        sb.Append("\"Note\":").Append(JsonString(t.Note));
                        sb.Append("}");
                    }
                }
                sb.Append("]");
                File.WriteAllText(target, sb.ToString(), new UTF8Encoding(false));
            }
            catch (Exception ex) { AppendLog("保存队列失败：" + ex.Message); }
        }

        /// <summary>
        /// Read the queue back. Rows are ordered by group number and then by position, and a group that
        /// was 运行中 when the app closed comes back as 等待 so it can be resumed.
        /// </summary>
        private void LoadQueue(string path = null)
        {
            _queue.Clear();
            _queueGroupIndex = -1;
            _queueTaskIndex = -1;
            try
            {
                var target = path ?? QueuePath;
                if (!File.Exists(target)) return;
                var rows = SimpleJson.Array(File.ReadAllText(target, Encoding.UTF8))
                    .Where(r => !string.IsNullOrEmpty(SimpleJson.Get(r, "Dir")))
                    .OrderBy(r => SimpleJson.GetInt(r, "Group"))
                    .ThenBy(r => SimpleJson.GetInt(r, "Ord"))
                    .ToList();
                TaskGroup cur = null;
                int curGroup = int.MinValue;
                foreach (var r in rows)
                {
                    int gn = SimpleJson.GetInt(r, "Group");
                    if (cur == null || gn != curGroup)
                    {
                        var gs = SimpleJson.Get(r, "GroupState");
                        cur = new TaskGroup
                        {
                            // A run interrupted by closing the window must not look finished.
                            State = string.IsNullOrEmpty(gs) || gs == "运行中" ? "等待" : gs
                        };
                        _queue.Add(cur);
                        curGroup = gn;
                    }
                    cur.Tasks.Add(new QueueTask
                    {
                        Dir = SimpleJson.Get(r, "Dir"),
                        Name = SimpleJson.Get(r, "Name") ?? Path.GetFileName((SimpleJson.Get(r, "Dir") ?? "").TrimEnd('\\', '/')),
                        Result = SimpleJson.Get(r, "Result") ?? "",
                        Note = SimpleJson.Get(r, "Note") ?? ""
                    });
                }
                if (_queue.Count > 0)
                    AppendLog("已读取任务队列：" + _queue.Count + " 组 / " + QueueTaskCount() + " 个任务（work\\queue.json）");
            }
            catch (Exception ex) { AppendLog("读取队列失败：" + ex.Message); }
        }

        /// <summary>Toggle one row's check by index, and repaint just that row.</summary>
        private int _lastToggleRow = -1;
        private DateTime _lastToggleAt = DateTime.MinValue;

        /// <summary>
        /// Toggle one row's check by index, and repaint just that row.
        ///
        /// Both the native click and WinForms' MouseUp call this, and on a platform that delivers both
        /// for one click that would toggle twice — i.e. not at all. A repeat for the same row inside
        /// 200 ms is therefore ignored; the cost is that a deliberate double-click counts once, which
        /// for a check box is what a double-click usually means anyway.
        /// </summary>
        private void ToggleRow(int idx)
        {
            if (idx < 0 || idx >= _games.Count) return;
            if (idx == _lastToggleRow && (DateTime.Now - _lastToggleAt).TotalMilliseconds < 200) return;
            _lastToggleRow = idx;
            _lastToggleAt = DateTime.Now;
            _games[idx].Checked = !_games[idx].Checked;
            Startup.Trace("勾选切换 行 " + idx + " → " + (_games[idx].Checked ? "已勾选" : "未勾选") +
                "，合计 " + _games.Count(x => x.Checked));
            _list.RedrawItems(idx, idx, false);
            UpdateButtons();
        }

        /// <summary>Toggle a set of rows by index (used by the space key).</summary>
        private void ToggleRows(ListView.SelectedIndexCollection indices)
        {
            if (indices == null || indices.Count == 0) return;
            bool anyUnchecked = false;
            foreach (int i in indices) if (i >= 0 && i < _games.Count && !_games[i].Checked) { anyUnchecked = true; break; }
            foreach (int i in indices)
            {
                if (i < 0 || i >= _games.Count) continue;
                _games[i].Checked = anyUnchecked;      // a mixed selection becomes all-checked
            }
            _list.RedrawItems(0, Math.Max(0, _games.Count - 1), false);
            UpdateButtons();
        }

        /// <summary>
        /// Give the game-name column whatever the pane has left after the fixed ones, so the state
        /// text is never the part that gets cut. Called on every resize and after a rebuild.
        /// </summary>
        private void ApplyColumnWidths()
        {
            if (_list == null || _list.Columns.Count < 5) return;
            int room = _list.ClientSize.Width;
            if (room <= 0) return;
            int fixedCols = _list.Columns[0].Width + _list.Columns[2].Width + 4;
            // Split the slack between the name and the state columns: the name needs the most, the
            // state needs enough for 「未汉化（已还原）」 plus a percentage.
            int stateW = Math.Max(150, Math.Min(260, room / 6));
            _list.Columns[4].Width = stateW;
            _list.Columns[3].Width = 150;
            _list.Columns[1].Width = Math.Max(140, room - fixedCols - stateW - _list.Columns[3].Width);
        }

        /// <summary>Right: the model, the progress, the controls, the log.</summary>
        private Control BuildControlPane()
        {
            // AutoScroll, and every button row wraps. A fixed one-line row is wider than the pane at
            // the default window size and at 200 % display scaling, so the buttons on the right of each
            // row (继续 / 终止 / 设置… / 打开日志文件) used to be cut off with no way to reach them.
            // Wrapping plus a scrollable host means the content always fits, whatever the size.
            var host = new Panel { Dock = DockStyle.Fill, Padding = new Padding(6, 0, 0, 0), AutoScroll = true };

            // ---- model row -------------------------------------------------------
            // A TableLayoutPanel, not a wrapping FlowLayoutPanel: a wrapped FlowLayoutPanel reports a
            // preferred height measured before wrapping, so its container ends up too short and the
            // rows overlap. A grid with AutoSize computes the height for the rows it actually used.
            var modelBox = new GroupBox { Dock = DockStyle.Top, Text = "翻译模型", AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, MinimumSize = new Size(0, 64) };
            var modelRow = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 2, Padding = new Padding(6, 4, 6, 0) };
            modelRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
            modelRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            _cmbModel = new ComboBox { Name = "cmbModel", Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList };
            _btnModelRefresh = MakeButton("刷新列表", (s, e) => RefreshModels());
            _btnModelStart = MakeButton("启动模型", (s, e) => StartLlama());
            _btnModelStop = MakeButton("停止模型", (s, e) => StopLlama());
            _lblModelState = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Text = "状态：未知", ForeColor = Color.DimGray };
            modelRow.Controls.Add(_cmbModel, 0, 0);
            modelRow.Controls.Add(_btnModelRefresh, 1, 0);
            modelRow.Controls.Add(_lblModelState, 0, 1);
            modelRow.Controls.Add(_btnModelStart, 1, 1);
            modelRow.Controls.Add(_btnModelStop, 1, 2);
            modelBox.Controls.Add(modelRow);

            // ---- detailed progress ----------------------------------------------
            // 180 px rather than 210: nine short rows plus two bars need about that, and every pixel
            // not used here becomes a row of history in the 翻译对照 panel below.
            var progBox = new GroupBox { Dock = DockStyle.Top, Height = 180, Text = "任务进度" };
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
            _lblEta = MakeStatLabel("预计：—");
            _lblElapsed = MakeStatLabel("用时：—");
            _lblModelNow = MakeStatLabel("模型：—");
            grid.Controls.Add(_lblBatch, 0, 0);
            grid.Controls.Add(_barBatch, 0, 1);
            grid.Controls.Add(_lblCurrent, 0, 2);
            grid.Controls.Add(_barGame, 0, 3);
            grid.Controls.Add(_lblCounts, 0, 4);
            grid.Controls.Add(_lblRate, 0, 5);
            grid.Controls.Add(_lblEta, 0, 6);
            grid.Controls.Add(_lblElapsed, 0, 7);
            grid.Controls.Add(_lblModelNow, 0, 8);
            progBox.Controls.Add(grid);

            // ---- task controls ---------------------------------------------------
            // Moved to the left pane (BuildTaskControlBox) so this column can give its height to the
            // 翻译对照 panel below.

            // ---- log -------------------------------------------------------------
            // Built in the left pane now (BuildLogBox): what is left on this side is the model row,
            // the progress panel and the pair panel, and the pair panel takes everything that is
            // left over.

            // ---- 翻译对照 --------------------------------------------------------
            // The pair the run just produced. Two read-only boxes for the current pair — a column would
            // cut a sentence off — plus the recent pairs below for scrolling back.
            //
            // This panel takes every pixel the fixed rows above and below do not need: it is where a
            // long sentence can actually be read, so it is the one area worth being generous with.
            var pairBox = new GroupBox { Dock = DockStyle.Fill, Text = "翻译对照（实时）", MinimumSize = new Size(0, 160) };

            var pairTop = new TableLayoutPanel
            {
                Dock = DockStyle.Top, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
                ColumnCount = 2, RowCount = 2, Padding = new Padding(6, 4, 6, 0)
            };
            pairTop.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 40f));
            pairTop.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
            _pairSrc = new TextBox
            {
                Name = "pairSrc", Dock = DockStyle.Fill, ReadOnly = true, Multiline = true,
                Height = 48, ScrollBars = ScrollBars.Vertical, BackColor = Color.FromArgb(252, 252, 252)
            };
            _pairDst = new TextBox
            {
                Name = "pairDst", Dock = DockStyle.Fill, ReadOnly = true, Multiline = true,
                Height = 48, ScrollBars = ScrollBars.Vertical, BackColor = Color.FromArgb(247, 252, 247)
            };
            pairTop.Controls.Add(new Label { Text = "原文", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft }, 0, 0);
            pairTop.Controls.Add(_pairSrc, 1, 0);
            pairTop.Controls.Add(new Label { Text = "译文", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft }, 0, 1);
            pairTop.Controls.Add(_pairDst, 1, 1);

            _pairList = new ListView
            {
                Name = "pairList", Dock = DockStyle.Fill, View = View.Details,
                FullRowSelect = true, GridLines = true, HideSelection = false,
                ShowItemToolTips = true, MultiSelect = false
            };
            _pairList.Columns.Add("原文", 200);
            _pairList.Columns.Add("译文", 200);
            _pairList.Resize += (s, e) =>
            {
                if (_pairList.Columns.Count < 2) return;
                int half = Math.Max(90, _pairList.ClientSize.Width / 2);
                _pairList.Columns[0].Width = half;
                _pairList.Columns[1].Width = Math.Max(90, _pairList.ClientSize.Width - half - 4);
            };

            var pairBar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 28, WrapContents = false, Padding = new Padding(4, 2, 0, 0) };
            _chkPairAuto = new CheckBox { Name = "pairAuto", Text = "自动滚动", Checked = true, AutoSize = true, Margin = new Padding(2, 4, 8, 0) };
            var btnPairClear = MakeButton("清空对照", (s, e) => ClearPairs());
            _lblPairCount = new Label { Name = "pairCount", AutoSize = true, Text = "本次已显示 0 条", TextAlign = ContentAlignment.MiddleLeft, Margin = new Padding(2, 7, 0, 0) };
            pairBar.Controls.Add(_chkPairAuto);
            pairBar.Controls.Add(btnPairClear);
            pairBar.Controls.Add(_lblPairCount);

            pairBox.Controls.Add(_pairList);
            pairBox.Controls.Add(pairBar);
            pairBox.Controls.Add(pairTop);
            Tip(_pairSrc, "本次运行刚翻译的原文。只显示本次新产生的对照；全部命中缓存的一轮不会显示任何内容，说明没有新翻译。");
            Tip(_pairList, "最近 " + PairHistoryMax + " 条：上面一行是最新的一条。勾上「自动滚动」会始终停在最新一条。");

            // Docked controls stack in reverse order of addition, so the fill control is added first
            // and the top row last. What is left in this column is the pair panel (fill, everything
            // the fixed rows do not need), the progress panel and the model row — the task controls
            // and the log moved to the left pane (BuildTaskControlBox / BuildLogBox).
            host.Controls.Add(pairBox);
            host.Controls.Add(progBox);
            host.Controls.Add(modelBox);
            return host;
        }

        /// <summary>
        /// The task controls, as one strip at the bottom of the left pane.
        ///
        /// They used to be a row in the right column. There, the height they took came straight out
        /// of the 翻译对照 panel, which is the area that has to be big: it is the only place the
        /// actual translation can be read. On the left the width is never in short supply (the pane
        /// is wider than the right column), and the strip sits under the game list.
        ///
        /// Three equal columns, as many rows as the buttons need. Every button is always on screen:
        /// nothing can be pushed off the right edge, whatever the window width or display scaling.
        /// </summary>
        private Control BuildTaskControlBox()
        {
            var actBox = new GroupBox { Dock = DockStyle.Bottom, Text = "任务控制", AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, MinimumSize = new Size(0, 104) };
            var act1 = MakeButtonGrid(3);
            _btnStartSel = MakeButton("开始汉化选中", (s, e) => StartTranslation(false));
            _btnStartAll = MakeButton("全部汉化", (s, e) => StartTranslation(true));
            _btnPause = MakeButton("暂停", (s, e) => Pause());
            _btnResume = MakeButton("继续", (s, e) => Resume());
            _btnStop = MakeButton("终止", (s, e) => Stop());
            AddToGrid(act1, _btnStartSel, _btnStartAll, _btnPause, _btnResume, _btnStop);

            var act2 = MakeButtonGrid(3);
            _btnCheck = MakeButton("检查翻译", (s, e) => StartCheck());
            _btnUninstall = MakeButton("卸载汉化", (s, e) => Uninstall());
            _btnRestore = MakeButton("恢复汉化", (s, e) => Restore());
            _btnSettings = MakeButton("设置…", (s, e) => OpenSettings());
            _btnOpenLog = MakeButton("打开日志文件", (s, e) => OpenLogFiles());
            AddToGrid(act2, _btnCheck, _btnUninstall, _btnRestore, _btnSettings, _btnOpenLog);
            actBox.Controls.Add(act2);
            actBox.Controls.Add(act1);
            return actBox;
        }

        /// <summary>
        /// The log, as a fixed strip at the bottom of the left pane.
        ///
        /// It shows the last few lines and nothing else, so it is the cheapest place to take height
        /// from; on the right it was costing the 翻译对照 panel the space it needs. Here it sits under
        /// the task controls, so "what I did" and "what came back" are in one column.
        /// </summary>
        private Control BuildLogBox()
        {
            var logBox = new GroupBox { Dock = DockStyle.Bottom, Height = 130, Text = "日志 / 错误", MinimumSize = new Size(0, 110) };
            _log = new TextBox
            {
                Name = "log",
                Dock = DockStyle.Fill, Multiline = true, ReadOnly = true,
                ScrollBars = ScrollBars.Both, WordWrap = false,
                Font = new Font("Consolas", 8.5f), BackColor = Color.FromArgb(250, 250, 250)
            };
            var logBar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 30, WrapContents = false };
            _btnClearLog = MakeButton("清空显示", (s, e) => _log.Clear());
            logBar.Controls.Add(_btnClearLog);
            logBox.Controls.Add(_log);
            logBox.Controls.Add(logBar);
            return logBox;
        }

        /// <summary>
        /// Show one newly produced pair.
        ///
        /// The pipeline emits `PAIR {"src":"…","dst":"…"}`, escaped by JSON.stringify, so one pair is
        /// always exactly one output line whatever the text contains — including the newlines that make a
        /// multi-line entry, which a tab- or pipe-separated format would have split.
        /// </summary>
        private void ShowPair(string json)
        {
            if (_pairSrc == null) return;
            var obj = SimpleJson.ParseFlat(json);
            string src = SimpleJson.Get(obj, "src");
            string dst = SimpleJson.Get(obj, "dst");
            if (string.IsNullOrEmpty(src) && string.IsNullOrEmpty(dst)) return;
            _pairSrc.Text = src ?? "";
            _pairDst.Text = dst ?? "";
            _pairCount++;
            if (_lblPairCount != null) _lblPairCount.Text = "本次已显示 " + _pairCount + " 条";
            if (_pairList == null) return;
            _pairList.BeginUpdate();
            try
            {
                var it = new ListViewItem(Flatten(src));
                it.SubItems.Add(Flatten(dst));
                it.ToolTipText = src + "\n\n→ " + dst;
                _pairList.Items.Insert(0, it);
                while (_pairList.Items.Count > PairHistoryMax) _pairList.Items.RemoveAt(_pairList.Items.Count - 1);
                if (_chkPairAuto == null || _chkPairAuto.Checked) _pairList.EnsureVisible(0);
            }
            finally { _pairList.EndUpdate(); }
        }

        /** One line for a cell: a ListView row cannot hold the line breaks a multi-line entry has. */
        private static string Flatten(string s)
        {
            return (s ?? "").Replace("\r\n", " ").Replace("\r", " ").Replace("\n", " ");
        }

        /// <summary>Empty the reference panel. Called when a run starts, so it always describes that run.</summary>
        private void ClearPairs()
        {
            _pairCount = 0;
            if (_pairSrc != null) _pairSrc.Clear();
            if (_pairDst != null) _pairDst.Clear();
            if (_pairList != null) _pairList.Items.Clear();
            if (_lblPairCount != null) _lblPairCount.Text = "本次已显示 0 条";
        }

        /// <summary>A grid of buttons: `columns` equal columns, as many rows as it takes.</summary>
        private static TableLayoutPanel MakeButtonGrid(int columns)
        {
            var t = new TableLayoutPanel
            {
                Dock = DockStyle.Top,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                ColumnCount = columns,
                Padding = new Padding(6, 4, 6, 0)
            };
            for (int i = 0; i < columns; i++) t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f / columns));
            return t;
        }

        /// <summary>Place buttons into a grid row by row, each stretched to its cell.</summary>
        private static void AddToGrid(TableLayoutPanel grid, params Control[] items)
        {
            for (int i = 0; i < items.Length; i++)
            {
                items[i].Dock = DockStyle.Fill;
                items[i].Margin = new Padding(2);
                grid.Controls.Add(items[i], i % grid.ColumnCount, i / grid.ColumnCount);
            }
        }

        private static Button MakeButton(string text, EventHandler onClick)
        {
            var b = new Button { Text = text, AutoSize = true, Height = 28, Margin = new Padding(0, 0, 6, 4) };
            b.Click += onClick;
            return b;
        }

        /// <summary>
        /// Attach a hover explanation. Buttons that are disabled during a run say why, instead of
        /// just going grey — a greyed control with no reason is what makes a window feel broken.
        /// </summary>
        private void Tip(Control c, string text)
        {
            if (c == null || string.IsNullOrEmpty(text)) return;
            if (_tips == null) _tips = new ToolTip { AutoPopDelay = 15000, InitialDelay = 400, ReshowDelay = 100 };
            _tips.SetToolTip(c, text);
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

        // Last known state of the model server, and when it was measured.
        //
        // The probe is a TCP connect with a 300 ms budget. It used to run inline here, and this method
        // is called from UpdateButtons — i.e. on every click on the list, every checkbox toggle, every
        // selection change — so the UI thread sat in a socket wait for up to 300 ms each time. That was
        // the unresponsive clicking. Now the probe runs on a background thread, at most once every few
        // seconds, and the label shows the last result in between.
        private bool _modelUp;
        private DateTime _modelProbeAt = DateTime.MinValue;
        private bool _modelProbeBusy;
        /// <summary>
        /// The model file the SERVER reports it loaded (`/props` → model_path), or null when unknown.
        ///
        /// This is not the same as the selection. The panel used to show `_settings.Model`, i.e. whatever
        /// the dropdown said — so after picking a smaller model and pressing 启动模型 the window would read
        /// 「模型：Hy-MT2-1.8B-Q8_0」 while the requests were still answered by the model that was already
        /// loaded. Measured on this machine: two llama-server processes can occupy one port at the same time
        /// (llama.cpp sets SO_REUSEADDR and Windows permits the second bind), so both models sat in a 6 GB
        /// card — 5,899 / 6,144 MiB used — and the traffic kept going to the older one. Asking the server
        /// what it loaded is the only way to know.
        /// </summary>
        private string _serverModel;
        /// <summary>True when the model the server reports differs from the one selected in the dropdown.</summary>
        private bool _modelMismatch;

        private void UpdateModelState()
        {
            // Refresh the reading in the background; never on this thread.
            if (!_modelProbeBusy && (DateTime.Now - _modelProbeAt).TotalSeconds > 3)
            {
                _modelProbeBusy = true;
                int port = _settings.Port;
                System.Threading.Tasks.Task.Run(() =>
                {
                    bool up = false;
                    string loaded = null;
                    long tokens = -1;
                    try
                    {
                        using (var c = new System.Net.Sockets.TcpClient())
                        {
                            var ar = c.BeginConnect("127.0.0.1", port, null, null);
                            up = ar.AsyncWaitHandle.WaitOne(300) && c.Connected;
                        }
                    }
                    catch { up = false; }
                    // What the server actually loaded, and how many tokens it has generated so far. Both are
                    // read-only, one short request every few seconds.
                    if (up)
                    {
                        loaded = AskLoadedModel(port);
                        tokens = AskPredictedTokens(port);
                    }
                    try
                    {
                        BeginInvoke(new Action(() =>
                        {
                            _modelUp = up;
                            _serverModel = loaded;
                            if (tokens >= 0) { _serverTokens = tokens; _serverTokensAt = DateTime.Now; }
                            else _serverTokensAt = DateTime.MinValue;      // unknown: rates must not guess
                            _modelProbeAt = DateTime.Now;
                            _modelProbeBusy = false;
                            ApplyModelState();
                        }));
                    }
                    catch { _modelProbeBusy = false; }
                });
            }
            ApplyModelState();
        }

        /// <summary>The model file the server says it loaded, or null. Runs off the UI thread.</summary>
        private static string AskLoadedModel(int port)
        {
            try
            {
                var body = HttpGet(port, "/props");
                if (body == null) return null;
                var props = SimpleJson.ParseFlat(body);
                string path = SimpleJson.Get(props, "model_path");
                return string.IsNullOrEmpty(path) ? null : Path.GetFileName(path);
            }
            catch { return null; }
        }

        /// <summary>Tokens the server has generated in total (Prometheus counter), or -1.</summary>
        private static long AskPredictedTokens(int port)
        {
            try { return ParsePredictedTokens(HttpGet(port, "/metrics")); } catch { return -1; }
        }

        /// <summary>
        /// Read `llamacpp:tokens_predicted_total` out of a Prometheus body, or -1.
        ///
        /// The `# HELP` and `# TYPE` lines carry the same metric name, so a plain substring search finds the
        /// description — whose value column is a word, not a number — and reports no figure at all. Only
        /// non-comment lines are considered, and the value must be digits.
        /// </summary>
        private static long ParsePredictedTokens(string body)
        {
            if (string.IsNullOrEmpty(body)) return -1;
            foreach (var raw in body.Split('\n'))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line[0] == '#') continue;
                if (!line.StartsWith("llamacpp:tokens_predicted_total", StringComparison.Ordinal)) continue;
                var parts = line.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 2) continue;
                long v;
                if (long.TryParse(parts[1], out v)) return v;
            }
            return -1;
        }

        /** A short GET, or null. Used only for the server's own read-only endpoints. */
        private static string HttpGet(int port, string pathAndQuery)
        {
            var req = (System.Net.HttpWebRequest)System.Net.WebRequest.Create(
                "http://127.0.0.1:" + port + pathAndQuery);
            req.Timeout = 2500;
            req.ReadWriteTimeout = 2500;
            req.Method = "GET";
            using (var resp = req.GetResponse())
            using (var sr = new System.IO.StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                return sr.ReadToEnd();
        }

        /// <summary>Paint the model state from the cached reading. No I/O, safe to call anywhere.</summary>
        private void ApplyModelState()
        {
            if (_lblModelState == null) return;
            string selected = _settings.Model ?? "";
            if (!_modelUp)
            {
                _lblModelState.Text = "状态：未启动";
                _lblModelState.ForeColor = Color.DimGray;
                _modelMismatch = false;
            }
            else if (string.IsNullOrEmpty(_serverModel))
            {
                // Answering, but /props could not be read: say so instead of implying the selection is what
                // is running.
                _lblModelState.Text = "状态：已就绪（模型未知）";
                _lblModelState.ForeColor = Color.SeaGreen;
                _modelMismatch = false;
            }
            else if (!string.Equals(_serverModel, selected, StringComparison.OrdinalIgnoreCase))
            {
                // The lie this label used to tell. Name both, and colour it as a problem.
                _lblModelState.Text = "状态：已就绪（实际 " + _serverModel + "，非所选 " + selected + "）";
                _lblModelState.ForeColor = Color.FromArgb(200, 90, 0);
                _modelMismatch = true;
            }
            else
            {
                _lblModelState.Text = "状态：已就绪（" + _serverModel + "）";
                _lblModelState.ForeColor = Color.SeaGreen;
                _modelMismatch = false;
            }
            Tip(_lblModelState, _modelMismatch
                ? "端口 " + _settings.Port + " 上的服务加载的是「" + _serverModel + "」，不是下拉里选的「" + selected + "」。\n" +
                  "翻译实际用的是前者。要让选择生效：点「停止模型」，或若该服务不是本程序启动的，先用任务管理器结束它，再点「启动模型」。"
                : "下拉里选中的模型就是服务实际加载的模型。");
            _btnModelStart.Enabled = !_running;
            _btnModelStop.Enabled = !_running && _modelUp;
        }

        // -------------------------------------------------------------- progress -----

        /// <summary>Redraw the progress panel. Driven by a timer so 用时 keeps counting.</summary>
        private void UpdateProgressPanel()
        {
            // Guarded so a diagnostic build with only part of the UI can still run its timers.
            if (_lblCounts == null || _lblModelNow == null || _lblModelState == null || _status == null) return;
            if (_running)
            {
                var el = DateTime.Now - _runStarted;
                _lblElapsed.Text = "用时：" + (el.TotalHours >= 1
                    ? (int)el.TotalHours + " 小时 " + el.Minutes + " 分"
                    : Math.Round(el.TotalMinutes, 1) + " 分");

                // rate from the last progress report, not from the batch start: a batch is
                // overwhelmingly dominated by whichever game is running now.
                if (_paused)
                {
                    // The pause is cooperative and per request, so this is true within seconds of the click.
                    // Showing it here is what tells the user the button worked during a long game, where the
                    // old game-level pause left the display unchanged for as long as the game ran.
                    _lblRate.Text = "速度：已暂停（当前请求结束后不再发出新请求）";
                    _lblEta.Text = "预计：已暂停";
                }
                else
                {
                    UpdateRates();
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
            // The speed sample and the run's own bookkeeping restart with the run.
            _rateSampleAt = DateTime.MinValue;
            _rateSampleTokens = 0;
            _rateSampleEntries = 0;
            _tokPerSec = 0;
            _entriesPerMin = 0;
            _runEntriesBase = 0;
            _runGames = new List<GameItem>();
            _currentItem = null;
            _lblRate.Text = "速度：—";
            _lblEta.Text = "预计：—";
            // A run must never inherit a pause from a previous one.
            ClearStalePauseFlag();
            // The reference panel describes one run, so it is emptied when one starts.
            ClearPairs();
        }

        // ------------------------------------------------------ speed and estimate ----

        /// <summary>
        /// Sample the throughput and refresh the two lines. Called once a second by the ticker, but it only
        /// takes a sample every RateWindowSeconds: both counters move in bursts (one reply per few seconds),
        /// so an instantaneous rate swings wildly and an estimate built on it would swing with it.
        /// </summary>
        private void UpdateRates()
        {
            if (_lblRate == null) return;
            int entriesNow = _runEntriesBase + _lastProgressCount;
            var now = DateTime.Now;
            if (_rateSampleAt == DateTime.MinValue || (now - _rateSampleAt).TotalSeconds >= RateWindowSeconds)
            {
                bool haveTokens = _serverTokens >= 0 && _serverTokensAt != DateTime.MinValue;
                // A counter that went BACKWARDS means a different server answered — two can hold one port
                // (llama.cpp sets SO_REUSEADDR and Windows allows it), and each keeps its own counters. The
                // baseline is restarted instead of reporting a negative rate from mixed series.
                if (_rateSampleAt != DateTime.MinValue && haveTokens && _serverTokens >= _rateSampleTokens)
                {
                    double secs = (now - _rateSampleAt).TotalSeconds;
                    if (secs >= 1)
                    {
                        _tokPerSec = (_serverTokens - _rateSampleTokens) / secs;
                        _entriesPerMin = 60.0 * (entriesNow - _rateSampleEntries) / secs;
                    }
                }
                else if (_rateSampleAt != DateTime.MinValue)
                {
                    _tokPerSec = 0;
                    _entriesPerMin = 0;
                }
                _rateSampleAt = now;
                _rateSampleTokens = haveTokens ? _serverTokens : 0;
                _rateSampleEntries = entriesNow;
            }

            string window = "近 " + RateWindowSeconds + " 秒";
            _lblRate.Text = "速度：" + _tokPerSec.ToString("0.0") + " tok/s（" + window + "）    " +
                _entriesPerMin.ToString("0.0") + " 条/分    已知已译 " + entriesNow + " 条";

            // ---- estimate -------------------------------------------------------------------------
            double perSec = _entriesPerMin / 60.0;
            if (perSec <= 0.0001)
            {
                _lblEta.Text = "预计：—（等 " + RateWindowSeconds + " 秒统计出速率）";
                Tip(_lblEta, "速度来自近 " + RateWindowSeconds + " 秒的采样。计数器刚重置、或刚好没有新译文时会是 0，稍等一个窗口即可。");
                return;
            }
            int gameRemaining = _gameTotal > 0 ? Math.Max(0, _gameTotal - _lastProgressCount) : 0;
            string gameEta = gameRemaining > 0
                ? FormatSpan(gameRemaining / perSec)
                : (_gameTotal > 0 ? "本局已译完" : "—");

            // The other games of this run contribute the size from their own progress report. A game that has
            // never been translated has no report, and is counted as UNKNOWN rather than as zero: an estimate
            // that silently leaves out half the work is worse than one that says what it does not know.
            int otherRemaining = 0, unknown = 0;
            foreach (var g in _runGames)
            {
                if (ReferenceEquals(g, _currentItem)) continue;         // already counted as the live game
                int e, d;
                if (TryReadProgress(g, out e, out d) && e > 0) otherRemaining += Math.Max(0, e - d);
                else unknown++;
            }
            int totalRemaining = gameRemaining + otherRemaining;
            string runEta = totalRemaining > 0
                ? FormatSpan(totalRemaining / perSec) + "（剩余 " + _runGames.Count + " 局、" + totalRemaining + " 条）"
                : "—";
            if (unknown > 0) runEta += "，另有 " + unknown + " 局大小未知";

            _lblEta.Text = "预计：本局 " + gameEta + "    |    本批 " + runEta;
            Tip(_lblEta, "按近 " + RateWindowSeconds + " 秒的「条/分」外推。\n" +
                         "本局 = 本局剩余条数 ÷ 速率；本批 = 本局剩余 + 其余未完成游戏在各自进度报告里的剩余条数。\n" +
                         "尚未翻译过的游戏没有报告，会被算作「大小未知」而不是 0，所以实际用时通常比粗估的更长。");
        }

        /** A duration as "1 小时 5 分" / "12 分 30 秒" / "45 秒". */
        private static string FormatSpan(double seconds)
        {
            if (seconds < 0 || double.IsNaN(seconds) || double.IsInfinity(seconds)) return "—";
            var t = TimeSpan.FromSeconds(seconds);
            if (t.TotalHours >= 1) return (int)t.TotalHours + " 小时 " + t.Minutes + " 分";
            if (t.TotalMinutes >= 1) return (int)t.TotalMinutes + " 分 " + t.Seconds + " 秒";
            return Math.Max(1, (int)Math.Round(t.TotalSeconds)) + " 秒";
        }

        // ---------------------------------------------------------------- games ------

        /// <summary>
        /// The game list, with the row click handled from the native message rather than from a
        /// MouseClick event.
        ///
        /// WinForms does not raise mouse events for a posted WM_LBUTTONDOWN on a native ListView, so a
        /// synthetic click cannot be used to verify the behaviour, and the handler's reachability is
        /// left to trust. Reading the hit test out of WM_LBUTTONUP makes the click path explicit, and
        /// it is what a real click sends too.
        /// </summary>
        private sealed class GameListView : ListView
        {
            public event Action<int> RowClicked;

            [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
            private struct LVHITTESTINFO { public int x, y, flags, iItem, iSubItem; }
            [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)]
            private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, ref LVHITTESTINFO lParam);
            private const int LVM_HITTEST = 0x1000 + 18;
            private const int WM_LBUTTONUP = 0x0202;
            private const int WM_PROBE = 0x0400 + 500;      // WM_USER + 500

            /// <summary>
            /// The row under the pointer, from the control's own hit test.
            ///
            /// WinForms' HitTest gives an item only after mapping the index back through Items[], which
            /// in virtual mode is not the object the control is showing — the click then looked like a
            /// miss. LVM_HITTEST answers with the index directly.
            /// </summary>
            private int RowAt(int x, int y)
            {
                var info = new LVHITTESTINFO { x = x, y = y, iItem = -1 };
                SendMessage(Handle, LVM_HITTEST, IntPtr.Zero, ref info);
                return info.iItem;
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == WM_LBUTTONUP)
                {
                    // Traced before the handler check on purpose: last time the trace sat behind
                    // `RowClicked != null`, so a message that arrived with no subscriber looked exactly
                    // like a message that never arrived.
                    try
                    {
                        int x = m.LParam.ToInt32() & 0xFFFF;
                        int y = (m.LParam.ToInt32() >> 16) & 0xFFFF;
                        int idx = RowAt(x, y);
                        Startup.Trace("列表点击 (" + x + "," + y + ") → 行 " + idx +
                            (RowClicked == null ? "  (无订阅者)" : ""));
                        if (idx >= 0 && RowClicked != null) RowClicked(idx);
                    }
                    catch (Exception ex) { Startup.Trace("列表点击出错：" + ex.Message); }
                }
                // A probe message: if this shows up in the trace, posted messages do reach this WndProc
                // and only the mouse ones are being swallowed; if it does not, the control never sees
                // posted input here and a synthetic click cannot verify the handler at all.
                if (m.Msg == WM_PROBE)
                {
                    Startup.Trace("收到探测消息 WM_PROBE");
                    return;
                }
                base.WndProc(ref m);
            }
        }

        /// <summary>
        /// One queued game. `Result` is empty while it is still to do, and one of 完成 / 失败 / 跳过 /
        /// 取消 afterwards, so a run can be stopped and resumed without redoing finished work.
        /// </summary>
        private sealed class QueueTask
        {
            public string Dir;
            public string Name;
            public string Result = "";
            public string Note = "";
        }

        /// <summary>
        /// One translation group: the tasks that run together, in order. Groups run one after another;
        /// a task appended to a group while it is running is picked up by the same pass.
        /// </summary>
        private sealed class TaskGroup
        {
            public string State = "等待";      // 等待 / 运行中 / 已完成 / 已跳过 / 已终止
            public readonly List<QueueTask> Tasks = new List<QueueTask>();
        }

        private sealed class GameItem
        {
            public string Dir;
            public string Name;
            public string Engine = "?";
            public int Entries = -1;
            public bool Checked;
            public string Status = "";      // short text shown in the 状态 column, e.g. 已汉化（本项目）97%
            public string StateNote = "";   // the long explanation, shown as a row tooltip
            public bool Skip;               // already Chinese: nothing to translate
            // Progress is read from the pipeline's report file once per game, not per repaint.
            public bool ProgressLoaded;
            public string ProgressText = "";
            public string ProgressDetail = "";
            public string Exe;
            public string OpenDir;
            public string LaunchProblem;
        }

        /// <summary>
        /// Load the game list from the scan cache.
        ///
        /// The cache is written by the scanner; a per-game state file (work\games-state.json,
        /// produced by tools\game-state.js) is merged in here when present, so the list can show
        /// which games are already Chinese or already translated without re-reading each game.
        /// </summary>
        private void LoadGames()
        {
            _games.Clear();
            var cache = Path.Combine(_settings.WorkDir, "games-cache.json");
            var state = LoadGameStates();
            if (File.Exists(cache))
            {
                try
                {
                    foreach (var g in SimpleJson.Array(File.ReadAllText(cache, Encoding.UTF8)))
                    {
                        string dir = SimpleJson.Get(g, "Dir") ?? SimpleJson.Get(g, "dir");
                        if (string.IsNullOrEmpty(dir)) continue;
                        var st = LoadGameStateOf(state, dir);
                        _games.Add(new GameItem
                        {
                            Dir = dir,
                            Name = Path.GetFileName(dir.TrimEnd('\\', '/')),
                            Engine = SimpleJson.Get(g, "Kind") ?? "?",
                            Entries = SimpleJson.GetInt(g, "Entries"),
                            Checked = false,
                            // Only the measured state is shown. This used to fall back to an AlreadyCn
                            // flag from the scan cache, which an older build wrote: 24 entries carried
                            // 「已汉化(跳过)」 and 20 of those games are actually Japanese, so the list
                            // claimed work that had never been done. An unknown game says so instead.
                            Status = st.Item1.Length > 0 ? st.Item1 : "未检查",
                            StateNote = st.Item2,
                            // Nothing to translate when the game ships its own Chinese: sending it
                            // through would replace official text with the model's.
                            Skip = st.Item1 == "已是中文" || st.Item1 == "自带中文"
                        });
                    }
                }
                catch (Exception ex) { AppendLog("读取 games-cache.json 失败：" + ex.Message); }
            }
            RefreshList();
        }

        /// <summary>State and note for one game, from the map LoadGameStates built.</summary>
        private static Tuple<string, string> LoadGameStateOf(Dictionary<string, Tuple<string, string>> map, string dir)
        {
            Tuple<string, string> t;
            if (map != null && map.TryGetValue(dir, out t) && t != null) return t;
            return Tuple.Create("", "");
        }

        /// <summary>
        /// Read work\games-state.json — one line per game, saying whether it is already Chinese,
        /// already translated, or still Japanese. Written by tools\game-state.js, which inspects the
        /// game (its data against the pristine backup) rather than trusting any earlier claim.
        ///
        /// The state and its explanation are kept apart: the column shows the state, and the full
        /// sentence goes to the row tooltip, because together they never fit in one column.
        /// Missing file simply means no state is shown.
        /// </summary>
        private Dictionary<string, Tuple<string, string>> LoadGameStates()
        {
            var map = new Dictionary<string, Tuple<string, string>>(StringComparer.OrdinalIgnoreCase);
            try
            {
                var path = Path.Combine(_settings.WorkDir, "games-state.json");
                if (!File.Exists(path)) return map;
                foreach (var g in SimpleJson.Array(File.ReadAllText(path, Encoding.UTF8)))
                {
                    string dir = SimpleJson.Get(g, "Dir") ?? SimpleJson.Get(g, "dir");
                    if (string.IsNullOrEmpty(dir)) continue;
                    map[dir] = Tuple.Create(SimpleJson.Get(g, "State") ?? "", SimpleJson.Get(g, "Note") ?? "");
                }
                AppendLog("已读取游戏状态：" + map.Count + " 条（work\\games-state.json）");
            }
            catch (Exception ex) { AppendLog("读取 games-state.json 失败：" + ex.Message); }
            return map;
        }

        /// <summary>
        /// Rebuild the game list's size.
        ///
        /// In virtual mode there are no rows to add: the control asks for a row when it needs one, so
        /// this only publishes the count. Nothing here can block, whatever the library size.
        /// </summary>
        private void RefreshList()
        {
            _list.VirtualListSize = 0;
            _list.VirtualListSize = _games.Count;
            ApplyColumnWidths();
            _status.Text = "共 " + _games.Count + " 个游戏，已勾选 " + _games.Count(x => x.Checked) + " 个";
            UpdateButtons();
        }

        /// <summary>Build one row's view from the model. Called only for rows the control needs.</summary>
        private ListViewItem MakeRow(GameItem g)
        {
            if (g.Exe == null && g.LaunchProblem == null) ResolveLaunchTarget(g);
            var it = new ListViewItem(g.Checked ? "☑" : "☐");     // the check is a character, see BuildGamePane
            it.SubItems.Add(g.Name);
            it.SubItems.Add(g.Engine);
            it.SubItems.Add(ReadProgress(g));
            // The column carries the state only; the explanation and the raw counts go to the
            // tooltip, where there is room for them.
            it.SubItems.Add(g.Status);
            it.Checked = g.Checked;
            it.Tag = g;
            var tip = new StringBuilder();
            tip.Append(g.Name).Append("\n").Append(g.Dir);
            if (g.Engine != null && g.Engine.Length > 0) tip.Append("\n引擎：").Append(g.Engine);
            if (g.Status.Length > 0) tip.Append("\n状态：").Append(g.Status);
            if (g.StateNote.Length > 0) tip.Append("（").Append(g.StateNote).Append("）");
            if (g.Entries >= 0) tip.Append("\n条目：").Append(g.Entries);
            var progress = ReadProgressDetail(g);
            if (progress.Length > 0) tip.Append("\n进度：").Append(progress);
            it.ToolTipText = tip.ToString();
            return it;
        }

        /// <summary>Read the pipeline's own report so the list never overstates progress.</summary>
        private string ReadProgress(GameItem g)
        {
            // Cached on the item: a row is rebuilt every time the control repaints, and reading the
            // report file per repaint made scrolling and clicking feel heavy.
            if (!g.ProgressLoaded)
            {
                int entries, done;
                g.ProgressLoaded = true;
                if (TryReadProgress(g, out entries, out done) && entries > 0)
                {
                    g.ProgressText = ((int)Math.Round(100.0 * done / entries)) >= 100 ? "已译完" : (int)Math.Round(100.0 * done / entries) + "%";
                    g.ProgressDetail = done + " / " + entries + " 条（" + Math.Round(100.0 * done / entries) + "%）";
                }
            }
            return g.ProgressText;
        }

        /// <summary>The same figures written out, for the row tooltip.</summary>
        private string ReadProgressDetail(GameItem g)
        {
            ReadProgress(g);                    // fills the cache
            return g.ProgressDetail;
        }

        /// <summary>
        /// The work-file stem for a game — the pipeline's own sanitizer (pipeline/index.js).
        ///
        /// It has to be the SAME rule. This used to keep every letter, digit and non-ASCII character and
        /// drop the rest, while the pipeline keeps ASCII alphanumerics and CJK, turns everything else into
        /// "_" and truncates to 60: "NTR Police ver1.10" became "NTRPolicever110" here and
        /// "NTR_Police_ver1_10" on disk. The names never matched, so the 进度 column could not read any
        /// report whatever the pipeline wrote, and with nothing writing the file either it always showed
        /// nothing at all.
        /// </summary>
        private static string WorkStem(string dir)
        {
            var name = Path.GetFileName(dir);
            var sb = new StringBuilder(name.Length);
            foreach (var c in name)
            {
                bool keep = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                            (c >= '\u4e00' && c <= '\u9fff');
                sb.Append(keep ? c : '_');
            }
            var s = sb.ToString();
            return s.Length > 60 ? s.Substring(0, 60) : s;
        }

        /// <summary>
        /// A report file belonging to this game, tolerating a future change to the sanitizer: the stem
        /// must be a prefix of the other's, on either side, and long enough that a match means something.
        /// </summary>
        private string FindReportByPrefix(string stem)
        {
            try
            {
                if (string.IsNullOrEmpty(stem) || stem.Length < 8) return null;
                foreach (var f in Directory.GetFiles(_settings.WorkDir, "*-translate-report.json"))
                {
                    var b = Path.GetFileName(f);
                    var other = b.Substring(0, b.Length - "-translate-report.json".Length);
                    int n = Math.Min(stem.Length, other.Length);
                    if (n < 8) continue;
                    if (string.Compare(stem, 0, other, 0, n, StringComparison.OrdinalIgnoreCase) == 0) return f;
                }
            }
            catch { }
            return null;
        }

        private bool TryReadProgress(GameItem g, out int entries, out int done)
        {
            entries = 0; done = 0;
            try
            {
                string stem = WorkStem(g.Dir);
                string report = Path.Combine(_settings.WorkDir, stem + "-translate-report.json");
                if (!File.Exists(report)) report = FindReportByPrefix(stem);
                if (report == null || !File.Exists(report)) return false;
                string txt = File.ReadAllText(report, Encoding.UTF8);
                entries = SimpleJson.GetInt(txt, "entries");
                done = SimpleJson.GetInt(txt, "translated");
                return true;
            }
            catch { return false; }
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
            // The rows live in the control's own cache in virtual mode, so the visible checkmarks are
            // refreshed by asking it to redraw from the model rather than by setting them one by one.
            if (_list.VirtualListSize > 0) _list.RedrawItems(0, _list.VirtualListSize - 1, false);
            UpdateButtons();
        }

        private void UpdateButtons()
        {
            int checkedGames = _games.Count(g => g.Checked);
            // The count line belongs here, not only in RefreshList: it used to be written when the list
            // was rebuilt, so ticking rows left it saying 「已勾选 0 个」 and the checks looked broken.
            if (_status != null)
                _status.Text = "共 " + _games.Count + " 个游戏，已勾选 " + checkedGames + " 个" +
                    (_running ? "（翻译进行中：取消勾选的游戏不会被开始）" : "");
            _btnStartSel.Enabled = !_running && checkedGames > 0;
            _btnStartAll.Enabled = !_running && _games.Count > 0;
            _btnStop.Enabled = _running;
            // 检查翻译 runs synchronously on this thread, so a click could not even be processed while it
            // works — the two buttons would be enabled and do nothing. They say so instead.
            _btnPause.Enabled = _running && !_paused && !_checking;
            _btnResume.Enabled = _running && _paused && !_checking;
            _btnCheck.Enabled = !_running && checkedGames > 0;

            // While a run is going, the list stays usable: scrolling, selecting, the right-click menu,
            // and checking/unchecking. Unchecking is how a run is stopped gently — the loop below does
            // not start a game whose box is now clear, so the current game finishes and the rest are
            // left alone. The buttons that rebuild or reorder the list itself stay off, because the
            // run iterates a snapshot of it; their tooltips say so.
            _list.Enabled = true;
            _btnSelectAll.Enabled = true;
            _btnClearSel.Enabled = true;

            _btnScan.Enabled = !_running;
            _btnAdd.Enabled = !_running;
            _btnRefresh.Enabled = !_running;
            _btnRescanAll.Enabled = !_running;
            _btnUninstall.Enabled = !_running && checkedGames == 1;
            _btnRestore.Enabled = !_running && checkedGames == 1;
            _btnState.Enabled = !_running;
            _btnSettings.Enabled = !_running;
            _cmbModel.Enabled = !_running && _cmbModel.Items.Count > 0 && !Convert.ToString(_cmbModel.SelectedItem).StartsWith("（");
            _btnModelRefresh.Enabled = !_running;

            // The queue. Adding to a group stays available during a run on purpose: the running group
            // re-reads its task list before every game, so a task added now is picked up by the same
            // pass, and one added to a later group is picked up when that group starts. The buttons
            // that rewrite the queue's order finish in whatever order the loop chose, so they wait.
            if (_btnNewGroupAddSel != null)
            {
                _btnNewGroupAddSel.Enabled = checkedGames > 0;
                _btnAddSelToGroup.Enabled = checkedGames > 0;
                _btnRemoveSel.Enabled = !_running && _queue.Count > 0;
                _btnClearQueue.Enabled = !_running && _queue.Count > 0;
                _btnSkipGroup.Enabled = _running;
                _btnStartQueue.Enabled = !_running && _queue.Count > 0;
                _cmbTargetGroup.Enabled = _queue.Count > 0 || checkedGames > 0;
                if (_status != null && _queue.Count > 0)
                    _status.Text += "；队列 " + _queue.Count + " 组 / " + QueueTaskCount() + " 个任务";
            }
            UpdateModelState();
        }

        /// <summary>
        /// Explain, on hover, what each run-locked button is for and why it is off just now.
        /// A greyed control with no reason reads as a broken window.
        /// </summary>
        private void TipRunLockedButtons()
        {
            const string running = "翻译进行中不可用：它会改动游戏列表，而当前批次是按开始时的列表跑的。\n" +
                                   "要提前结束，取消勾选不想翻的游戏（当前这个跑完就停），或点「终止」。";
            Tip(_btnScan, running);
            Tip(_btnAdd, running);
            Tip(_btnRefresh, running);
            Tip(_btnRescanAll, running);
            Tip(_btnState, running);
            Tip(_btnSettings, "翻译进行中不可用（改动设置会影响正在跑的任务）。");
            Tip(_btnStartSel, "勾选要汉化的游戏后可用。翻译进行中不可用。");
            Tip(_btnStartAll, "把列表里所有游戏依次汉化。翻译进行中不可用。");
            Tip(_btnCheck, "对勾选的游戏做一次质检。翻译进行中不可用。");
            Tip(_btnUninstall, "把勾选的那一个游戏还原成日文原版（需先勾选恰好一个）。");
            Tip(_btnRestore, "把勾选的那一个游戏切回汉化版（需先勾选恰好一个）。");
            Tip(_btnStop, "停止整个批次。已经完成的译文会保留。");
            Tip(_btnPause, "暂停翻译：当前这一条请求结束后不再发出新请求（通常几秒内生效），进度与缓存都保留。\n" +
                           "「继续」从停下的地方接着跑。要彻底停下用「终止」。");

            // The queue panel. The two 加入 buttons are the ones that deliberately keep working during
            // a run, so their tips say so rather than saying "unavailable while running".
            Tip(_queueTree, "按组顺序执行：第 1 组跑完自动进第 2 组。\n展开一组可以看到其中每个游戏的结果。\n" +
                            "运行中也能给任意一组加任务——加进正在跑的那组会被本次带上，加进后面的组在它开始时执行。");
            Tip(_btnNewGroupAddSel, "把勾选的游戏建成新的一组，追加到队列末尾。翻译进行中也可用。");
            Tip(_btnAddSelToGroup, "把勾选的游戏追加到右边下拉框选中的那一组。翻译进行中也可用。");
            Tip(_btnRemoveSel, "把勾选的游戏从队列里移出（游戏本身与已翻译的成果不受影响）。翻译进行中不可用。");
            Tip(_btnClearQueue, "清空整个队列。不会删除任何游戏数据或译文。翻译进行中不可用。");
            Tip(_btnSkipGroup, "放弃当前组里剩下没跑的任务，直接进入下一组。只在翻译进行中可用。");
            Tip(_btnStartQueue, "从第一组开始，一组跑完自动进下一组。已经跑完的组会跳过（可续跑）。");
            Tip(_cmbTargetGroup, "「加入选中到所选组」的目标组。");
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
        // ------------------------------------------------------------------ state ------

        /// <summary>
        /// Recompute, for every game in the list, whether it is already Chinese or already
        /// translated, and show that in the 状态 column.
        ///
        /// The work is done by tools\game-state.js, which inspects each game (its data against the
        /// pristine backup, and its dialogue folder) rather than trusting any earlier claim; the
        /// result is written to work\games-state.json, which LoadGames reads. Running it in a child
        /// process keeps a half-minute scan off the UI thread.
        /// </summary>
        private void RefreshGameStates()
        {
            var node = Path.Combine(_root, "node", "node.exe");
            var tool = Path.Combine(_root, "tools", "game-state.js");
            var cache = Path.Combine(_settings.WorkDir, "games-cache.json");
            if (!File.Exists(node)) { AppendLog("找不到 " + node + "，无法计算游戏状态。"); return; }
            if (!File.Exists(tool)) { AppendLog("找不到 " + tool + "（发布时需一并拷贝 tools 目录）。"); return; }
            if (!File.Exists(cache)) { AppendLog("还没有游戏列表，先扫描路径。"); return; }

            AppendLog("正在检查 " + _games.Count + " 个游戏的状态（读取每个游戏的数据并与原版对比）…");
            _btnState.Enabled = false;

            string args = PipelineRunner.Join(new string[] {
                PipelineRunner.Quote(tool),
                "--cache", PipelineRunner.Quote(cache),
                "--outdir", PipelineRunner.Quote(_settings.WorkDir),
                "--out", "games-state.json",
                "--quiet"
            });

            var psi = new ProcessStartInfo(node)
            {
                Arguments = args,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                // Node writes UTF-8. Without this the reader decodes it with the console's ANSI code
                // page, so every Chinese line arrives as 「姹囨€伙紙110 涓父鎴忥級」 — the same trap as
                // the .bat encoding one, and it is set here and in the pipeline reader for that reason.
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                WorkingDirectory = _root
            };
            try
            {
                var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
                var sb = new StringBuilder();
                p.OutputDataReceived += (s, e) => { if (e.Data != null) sb.AppendLine(e.Data); };
                p.ErrorDataReceived += (s, e) => { if (e.Data != null) sb.AppendLine(e.Data); };
                p.Exited += (s, e) =>
                {
                    try
                    {
                        BeginInvoke(new Action(() =>
                        {
                            string tail = sb.ToString().Trim();
                            if (tail.Length > 0) AppendLog(tail);
                            LoadGames();
                            AppendLog("状态已更新：已汉化的游戏在状态列标出，不必重复翻译。");
                            UpdateButtons();
                        }));
                    }
                    catch { }
                };
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
            }
            catch (Exception ex)
            {
                AppendLog("计算游戏状态失败：" + ex.Message);
                _btnState.Enabled = true;
            }
        }

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
            // Single-task entry point: add just this game to the queue, into an existing group or a new
            // one. The dropdown is rebuilt every time the menu opens, so it always shows the real groups
            // and their sizes.
            menu.Items.Add(new ToolStripSeparator());
            var miQueue = new ToolStripMenuItem("加入队列");
            menu.Items.Add(miQueue);
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

                miQueue.DropDownItems.Clear();
                miQueue.Enabled = has;
                if (!has) return;
                var game = g;
                var miNew = new ToolStripMenuItem("加入新的组");
                miNew.Click += (s2, e2) => AddTasks(new TaskGroup(), new List<GameItem> { game });
                miQueue.DropDownItems.Add(miNew);
                for (int i = 0; i < _queue.Count; i++)
                {
                    int gi = i;
                    var mi = new ToolStripMenuItem("加入第 " + (i + 1) + " 组（" + _queue[i].Tasks.Count + " 个）");
                    mi.Click += (s2, e2) =>
                    {
                        if (gi < _queue.Count) AddTasks(_queue[gi], new List<GameItem> { game });
                    };
                    miQueue.DropDownItems.Add(mi);
                }
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
            // Virtual mode supplies no SelectedItems: the selection is an index into the model.
            if (_list == null || _list.SelectedIndices.Count == 0) return null;
            int i = _list.SelectedIndices[0];
            return i >= 0 && i < _games.Count ? _games[i] : null;
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
            if (!await EnsureModelReadyAsync()) return;

            _running = true; _paused = false;
            _cts = new CancellationTokenSource();
            ResetProgress();
            // What this run still has to do, for the estimate. Games marked 已是中文 are left out: they are
            // not translated, so counting their size would inflate the figure.
            _runGames = list.Where(g => !g.Skip).ToList();
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

                if (g.Skip)
                {
                    skipped.Add(g.Name + "（已是中文）");
                    _skipCount++;
                    _runner.LogSkip(g.Name + "  已跳过：检测为已是中文");
                    continue;
                }

                // Unchecking a game while the batch runs means "do not start this one". The list is a
                // snapshot, so the loop has to consult the model again here — that is what makes the
                // checkbox a usable control during a run instead of a decoration.
                if (!g.Checked)
                {
                    skipped.Add(g.Name + "（运行中取消勾选）");
                    _skipCount++;
                    AppendLog("⤼ 已取消勾选，跳过 " + g.Name);
                    continue;
                }
                while (_paused && !_cts.IsCancellationRequested) await Task.Delay(500);
                if (_cts.IsCancellationRequested) break;

                _currentGame = g.Name;
                _currentItem = g;
                _lblCurrent.Text = "当前：" + g.Name;
                _barGame.Value = 0;
                _lastProgressAt = DateTime.MinValue;
                _lastProgressCount = 0;
                AppendLog("═══ 开始 " + g.Name + " ═══");

                var outcome = await _runner.RunAsync(g.Dir, _settings.PromptFile, _cts.Token);
                // The game leaves the run's remaining set, and the entries it translated move into the
                // baseline so the sampled 条/分 keeps counting across games.
                if (_runGames.Contains(g)) _runGames.Remove(g);
                _runEntriesBase += _lastProgressCount;
                if (outcome.Succeeded) { g.Status = "已完成"; AppendLog("✔ " + g.Name + " 完成（尝试 " + outcome.AttemptsUsed + " 次）"); }
                else if (outcome.SkipReason == "用户终止") { AppendLog("■ 已终止"); break; }
                else { g.Status = "失败已跳过"; failed.Add(g.Name + "：" + outcome.SkipReason); AppendLog("✖ " + g.Name + " 已跳过 —— " + outcome.SkipReason); }
                RefreshList();
            }

            EndRun("批次");

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

        /// <summary>
        /// Common end-of-run state reset, shared by the one-shot batch and the queue. `label` only
        /// changes the wording of the batch line, so the one-shot batch still reports 批次.
        /// </summary>
        private void EndRun(string label)
        {
            _running = false;
            _cts = null;
            _barBatch.Value = 1000;
            _lblBatch.Text = label + "：已完成 " + _batchDone + " / " + _batchTotal;
            _lblCurrent.Text = "当前：空闲";
            RefreshQueuePanel();
            UpdateButtons();
        }

        /// <summary>
        /// Make sure the translation server is up, offering to start it. Returns false only when the
        /// user cancels or the start times out — the same contract the batch always had.
        /// </summary>
        private async Task<bool> EnsureModelReadyAsync()
        {
            if (IsPortOpen()) return true;
            var answer = MessageBox.Show(this,
                "翻译模型服务还没有启动。\n\n是否现在启动「" + _settings.Model + "」？\n\n" +
                "模型加载需要 30-45 秒，管线会自动等待。",
                "需要启动模型", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
            if (answer == DialogResult.Cancel) return false;
            if (answer == DialogResult.Yes)
            {
                StartLlama();
                for (int i = 0; i < 60 && !IsPortOpen(); i++) await Task.Delay(1000);
                if (!IsPortOpen())
                {
                    MessageBox.Show(this, "模型服务启动失败或超时，请查看日志。", "启动失败");
                    return false;
                }
            }
            return true;
        }

        // ------------------------------------------------------- grouped queue run -----

        /// <summary>
        /// Run the queue: every group in order, every task in a group in order, and the next group
        /// starts by itself when the current one finishes.
        ///
        /// Two properties this relies on, both deliberate:
        ///
        ///   * The inner loop re-reads `grp.Tasks.Count` on every pass, so a task appended to the group
        ///     that is running right now is picked up by the same pass. Adding to a later group is
        ///     picked up when that group starts.
        ///   * This is `async void` on the UI thread and nothing uses ConfigureAwait(false), so every
        ///     continuation resumes on the UI thread. A click handler therefore runs interleaved with
        ///     this loop at an await point, and mutating the task list from it needs no locking.
        ///
        /// Stopping: 终止 cancels the whole queue (the running group is marked 已终止 and the groups not
        /// yet started stay 等待, so 开始队列 resumes); 跳过本组 only abandons the rest of the current
        /// group. Nothing here writes to a game or to a pipeline cache — the only file written is
        /// work\queue.json.
        /// </summary>
        private async void RunQueue()
        {
            if (_queue.Count == 0)
            {
                MessageBox.Show(this, "队列是空的。\n\n先勾选要翻译的游戏，再点「新建组并加入选中」。",
                    "队列为空", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            bool allDone = _queue.All(g => g.State == "已完成" || g.State == "已跳过" || g.State == "已终止");
            if (allDone)
            {
                if (MessageBox.Show(this, "队列里的组都已经跑过了。\n\n是否清空各项结果并重新跑一遍？",
                        "队列已完成", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
                foreach (var g in _queue)
                {
                    g.State = "等待";
                    foreach (var t in g.Tasks) { t.Result = ""; t.Note = ""; }
                }
                SaveQueue();
                RefreshQueuePanel();
            }

            if (!await EnsureModelReadyAsync()) return;

            _running = true; _paused = false; _skipGroupRequested = false;
            _cts = new CancellationTokenSource();
            ResetProgress();
            // The run's remaining games, for the estimate: every unfinished task that maps to a game which
            // is actually translatable.
            _runGames = new List<GameItem>();
            for (int gi = 0; gi < _queue.Count; gi++)
            {
                if (_queue[gi].State == "已完成" || _queue[gi].State == "已跳过" || _queue[gi].State == "已终止") continue;
                foreach (var t in _queue[gi].Tasks)
                {
                    if (t.Result == "完成") continue;
                    var it = _games.FirstOrDefault(x => SameDir(x.Dir, t.Dir));
                    if (it != null && !it.Skip) _runGames.Add(it);
                }
            }
            _barGame.Maximum = 1000;
            _batchTotal = QueueTaskCount();
            _batchDone = 0;
            UpdateButtons();

            var completed = new List<string>();
            var failed = new List<string>();
            var skipped = new List<string>();
            bool cancelled = false;

            for (int gi = 0; gi < _queue.Count; gi++)
            {
                if (cancelled) break;
                var grp = _queue[gi];
                // Resume: a group that already finished is not run again.
                if (grp.State == "已完成" || grp.State == "已跳过" || grp.State == "已终止") continue;

                grp.State = "运行中";
                _queueGroupIndex = gi;
                _queueTaskIndex = -1;
                SaveQueue();
                RefreshQueuePanel();

                for (int ti = 0; ti < grp.Tasks.Count; ti++)      // Count re-read: mid-run additions run
                {
                    if (_cts.IsCancellationRequested) { cancelled = true; break; }
                    while (_paused && !_cts.IsCancellationRequested) await Task.Delay(500);
                    if (_cts.IsCancellationRequested) { cancelled = true; break; }
                    if (_skipGroupRequested) break;

                    var t = grp.Tasks[ti];
                    if (t.Result == "完成") continue;             // already done in an earlier pass
                    _queueTaskIndex = ti;
                    _lblBatch.Text = QueueBatchLabel(gi) + "，本组 " + (ti + 1) + " / " + grp.Tasks.Count + " 个";
                    _barBatch.Value = Math.Min(1000, (int)(1000.0 * _batchDone / Math.Max(1, _batchTotal)));

                    var g = _games.FirstOrDefault(x => SameDir(x.Dir, t.Dir));
                    if (g == null)
                    {
                        t.Result = "跳过"; t.Note = "游戏已不在列表中";
                        skipped.Add(t.Name + "（不在列表）");
                        _batchDone++;
                        AppendLog("⤼ 跳过 " + t.Name + "：已不在游戏列表中");
                        SaveQueue(); RefreshQueuePanel();
                        continue;
                    }
                    if (g.Skip)
                    {
                        t.Result = "跳过"; t.Note = "已是中文";
                        skipped.Add(t.Name + "（已是中文）");
                        _batchDone++; _skipCount++;
                        _runner.LogSkip(t.Name + "  已跳过：检测为已是中文");
                        AppendLog("⤼ 跳过 " + t.Name + "：已是中文");
                        SaveQueue(); RefreshQueuePanel();
                        continue;
                    }

                    _currentGame = t.Name;
                    _currentItem = g;
                    _lblCurrent.Text = "当前：" + t.Name + "（第" + (gi + 1) + "组 " + (ti + 1) + "/" + grp.Tasks.Count + "）";
                    _barGame.Value = 0;
                    _lastProgressAt = DateTime.MinValue;
                    _lastProgressCount = 0;
                    AppendLog("═══ 开始 " + t.Name + "（第" + (gi + 1) + "组）═══");

                    var outcome = await _runner.RunAsync(g.Dir, _settings.PromptFile, _cts.Token);
                    // Same bookkeeping as the one-shot batch: the game leaves the run's remaining set and
                    // its entries join the baseline the 条/分 sample counts against.
                    if (_runGames.Contains(g)) _runGames.Remove(g);
                    _runEntriesBase += _lastProgressCount;
                    if (outcome.Succeeded)
                    {
                        t.Result = "完成"; t.Note = "";
                        g.Status = "已完成";
                        completed.Add(t.Name);
                        _batchDone++;
                        AppendLog("✔ " + t.Name + " 完成（尝试 " + outcome.AttemptsUsed + " 次）");
                    }
                    else if (outcome.SkipReason == "用户终止")
                    {
                        t.Result = "取消"; t.Note = "用户终止";
                        cancelled = true;
                    }
                    else
                    {
                        t.Result = "失败"; t.Note = outcome.SkipReason ?? "未知原因";
                        g.Status = "失败已跳过";
                        failed.Add(t.Name + "：" + t.Note);
                        _batchDone++;
                        AppendLog("✖ " + t.Name + " 已跳过 —— " + t.Note);
                    }
                    SaveQueue();
                    RefreshQueuePanel();
                    RefreshList();
                }

                grp.State = cancelled ? "已终止" : (_skipGroupRequested ? "已跳过" : "已完成");
                _skipGroupRequested = false;
                SaveQueue();
                RefreshQueuePanel();
            }

            _queueGroupIndex = -1;
            _queueTaskIndex = -1;
            SaveQueue();
            EndRun("队列");

            var sb = new StringBuilder("队列结束。\n完成 " + completed.Count + " 个");
            if (skipped.Count > 0) sb.Append("，跳过 " + skipped.Count + " 个");
            if (failed.Count > 0)
            {
                sb.Append("，失败并跳过 " + failed.Count + " 个：\n");
                foreach (var f in failed.Take(8)) sb.Append("  · " + f + "\n");
                sb.Append("\n详细记录见 work\\errors.log 与 work\\skips.log");
            }
            if (cancelled) sb.Append("\n\n已终止：没轮到的组仍留在队列里，再次「开始队列」即可续跑。");
            MessageBox.Show(this, sb.ToString(), "任务队列结果", MessageBoxButtons.OK,
                failed.Count > 0 ? MessageBoxIcon.Warning : MessageBoxIcon.Information);
        }

        /// <summary>Batch line wording for a group: "队列：第 2 / 3 组".</summary>
        private string QueueBatchLabel(int gi)
        {
            return "队列：第 " + (gi + 1) + " / " + _queue.Count + " 组";
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
            // 暂停 cannot act here: this method runs synchronously and the window is not pumping messages,
            // so the buttons are disabled for its duration rather than left clickable but dead.
            _checking = true;
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
            _checking = false;
            _running = false; UpdateButtons();
        }

        private void Pause()
        {
            _paused = true;
            WritePauseFlag(true);
            AppendLog("⏸ 已暂停：当前这一条请求结束后不再发出新请求（通常几秒内）。点「继续」恢复。");
            UpdateButtons();
        }

        private void Resume()
        {
            _paused = false;
            WritePauseFlag(false);
            AppendLog("▶ 已继续。");
            UpdateButtons();
        }

        /// <summary>
        /// The file the translate loop watches, next to the other work files.
        ///
        /// The pipeline is a separate process, so a pause has to be cooperative: the window drops this file
        /// and the loop waits between requests (pipeline/translate/index.js waitWhilePaused). Per-request
        /// granularity is the point — pausing only between games meant the button looked dead for as long as
        /// the current game took, which on a large one is hours.
        /// </summary>
        private string PauseFlagPath
        {
            get { return Path.Combine(_settings.WorkDir, "paused.flag"); }
        }

        /// <summary>Create or remove the pause flag, reporting a failure instead of pausing silently.</summary>
        private void WritePauseFlag(bool paused)
        {
            try
            {
                if (paused)
                {
                    Directory.CreateDirectory(_settings.WorkDir);
                    File.WriteAllText(PauseFlagPath, "paused " + DateTime.Now.ToString("s"), new UTF8Encoding(false));
                }
                else if (File.Exists(PauseFlagPath)) File.Delete(PauseFlagPath);
            }
            catch (Exception ex)
            {
                AppendLog("暂停标记写入失败（暂停可能不生效）：" + ex.Message);
            }
        }

        /// <summary>
        /// Drop a flag left behind by a run that was paused when it died. Without this the next run would
        /// sit waiting for a 「继续」 nobody pressed.
        /// </summary>
        private void ClearStalePauseFlag()
        {
            try
            {
                if (!File.Exists(PauseFlagPath)) return;
                File.Delete(PauseFlagPath);
                AppendLog("已清除上一次运行遗留的暂停标记。");
            }
            catch (Exception ex) { AppendLog("清除暂停标记失败：" + ex.Message); }
        }

        private void Stop()
        {
            if (_cts == null) return;
            if (MessageBox.Show(this, "确定终止当前批次？已经完成的译文会保留，下次可从进度继续。",
                    "终止", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
            AppendLog("■ 正在终止…");
            // Clear the pause first: a pause left standing would make the next run wait for a 「继续」
            // nobody pressed.
            _paused = false;
            WritePauseFlag(false);
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
                        "本程序自带的运行目录：\n" + Path.Combine(_root, "llama"),
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
                // effect. A server started elsewhere is left alone — but if one is HOLDING THE PORT it has
                // to go, or the new server binds alongside it and nothing changes.
                //
                // Windows permits a second bind on the same port here (llama.cpp sets SO_REUSEADDR), so this
                // does not fail loudly: measured on this machine, the previous model and the newly started
                // one both listened on 18080, both sat in a 6 GB card (5,899 / 6,144 MiB used), and every
                // request still went to the older one while the window reported the new model as ready.
                StopLlama(quiet: true);
                if (IsPortOpen())
                {
                    var owners = PortOwners(_settings.Port);
                    string who = owners.Count > 0
                        ? string.Join("、", owners.Select(p => "PID " + p).ToArray())
                        : "另一个进程";
                    var answer = MessageBox.Show(this,
                        "端口 " + _settings.Port + " 已被" + who + "占用，但它不是本程序启动的模型服务" +
                        (string.IsNullOrEmpty(_serverModel) ? "" : "（它加载的是 " + _serverModel + "）") + "。\n\n" +
                        "Windows 允许两个服务同时监听一个端口，所以继续启动不会报错 —— 结果是两个模型都占着显存，" +
                        "而翻译仍然由旧的那个应答。\n\n" +
                        "是 = 结束" + who + "，然后加载「" + model + "」\n" +
                        "否 = 什么都不做（保持现状）",
                        "端口已被占用", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                    if (answer != DialogResult.Yes) return;
                    foreach (var p in owners) KillProcessTree(p);
                    for (int i = 0; i < 20 && IsPortOpen(); i++) System.Threading.Thread.Sleep(250);
                    if (IsPortOpen())
                    {
                        MessageBox.Show(this,
                            "端口 " + _settings.Port + " 仍然被占用，无法启动新模型。\n\n" +
                            "请手动结束占用它的进程后重试。", "仍然被占用", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        return;
                    }
                    AppendLog("已结束占用端口 " + _settings.Port + " 的进程" +
                        (owners.Count > 0 ? "（" + string.Join("、", owners.Select(p => "PID " + p).ToArray()) + "）" : "") + "。");
                }

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

                // A process that dies within a couple of seconds never loads anything (a bad path, not
                // enough memory for the offload). Say so instead of leaving 「加载中…」 on screen for a
                // server that no longer exists.
                System.Threading.Thread.Sleep(1500);
                if (proc != null && proc.HasExited)
                {
                    string err = "模型进程启动后立即退出（退出码 " + proc.ExitCode + "）。加载失败，本次没有启动任何服务。";
                    AppendLog("✖ " + model + "：" + err);
                    _runner.LogError("启动模型服务失败：" + model + "  " + err);
                    _lblModelState.Text = "状态：启动失败";
                    _lblModelState.ForeColor = Color.Firebrick;
                    MessageBox.Show(this, err + "\n\n常见原因：显存不足（先停掉其他模型服务）、模型文件损坏。",
                        "启动失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }

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

        // --- which process holds a local port --------------------------------------------------------
        //
        // Asked of iphlpapi in this process. The obvious alternative — parse `netstat -ano` — means
        // spawning a shell command, and its output would also have to be matched through a localized header
        // and state word.
        [System.Runtime.InteropServices.DllImport("iphlpapi.dll", SetLastError = true)]
        private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, int reserved);

        private const int AF_INET = 2;
        private const int TCP_TABLE_OWNER_PID_LISTENER = 3;
        private const uint ERROR_INSUFFICIENT_BUFFER = 122;

        /// <summary>
        /// Every PID listening on a local IPv4 port.
        ///
        /// A LIST, not one PID, because two processes really can hold the same port on Windows: measured
        /// here, the previous model and the newly started one both listened on 18080. Killing only one
        /// would leave the port occupied and the takeover would look like it failed.
        /// </summary>
        private static List<int> PortOwners(int port)
        {
            var found = new List<int>();
            int size = 0;
            if (GetExtendedTcpTable(IntPtr.Zero, ref size, true, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0) != ERROR_INSUFFICIENT_BUFFER
                || size <= 0) return found;
            IntPtr buf = System.Runtime.InteropServices.Marshal.AllocHGlobal(size);
            try
            {
                if (GetExtendedTcpTable(buf, ref size, true, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0) != 0) return found;
                int rows = System.Runtime.InteropServices.Marshal.ReadInt32(buf);
                // MIB_TCPTABLE_OWNER_PID: a DWORD count, then rows of six DWORDs —
                // state, localAddr, localPort, remoteAddr, remotePort, owningPid.
                long row = (long)buf + 4;
                for (int i = 0; i < rows; i++, row += 24)
                {
                    uint localPort = (uint)System.Runtime.InteropServices.Marshal.ReadInt32((IntPtr)row, 8);
                    // The port sits network-ordered in the low half of the DWORD.
                    int p = ((int)(localPort & 0xFF) << 8) | (int)((localPort >> 8) & 0xFF);
                    if (p != port) continue;
                    int pid = System.Runtime.InteropServices.Marshal.ReadInt32((IntPtr)row, 20);
                    if (pid > 0 && !found.Contains(pid)) found.Add(pid);
                }
            }
            catch { }
            finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(buf); }
            return found;
        }

        /// <summary>The first PID listening on a port, or -1. For messages and checks.</summary>
        private static int PortOwner(int port)
        {
            var all = PortOwners(port);
            return all.Count > 0 ? all[0] : -1;
        }

        /// <summary>End a process. llama-server has no children, and Process.Kill needs no shell.</summary>
        private void KillProcessTree(int pid)
        {
            try
            {
                using (var p = Process.GetProcessById(pid)) p.Kill();
            }
            catch (Exception ex) { AppendLog("结束进程 " + pid + " 失败：" + ex.Message); }
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
            if (line.StartsWith("PAIR ")) { ShowPair(line.Substring(5)); return; }   // the 对照 panel shows it

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

