using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
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
    }

    [DataContract]
    public class Settings
    {
        [DataMember] public string ModelDir = "D:\\galtrans";
        [DataMember] public string LlamaDir = "D:\\GameTranslator\\llama";
        [DataMember] public string Device = "gpu";
        [DataMember] public int MaxMemoryMB = 0;
        [DataMember] public int Port = 18080;
    }

    public class MainForm : Form
    {
        private ListView list;
        private Button btnScan, btnScanFolder, btnAdd, btnSelectAll, btnStartAll, btnRestore,
            btnRefreshModels, btnModelDir, btnStart, btnPause, btnStop;
        private ComboBox cmbModel, cmbDevice;
        private TextBox txtScanPath;
        private ProgressBar progress;
        private Label lblStatus;
        private RichTextBox log;
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
            Text = "RPG Maker 汉化管理器 v2.2";
            Width = 1740;
            Height = 720;
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
            SetLlamaStatus("未启动");
            Log("llama 内存上限: " + llamaMemLimitMB + " MB（可在 settings.json 的 MaxMemoryMB 调整，0=自动）");
        }

        private void BuildUi()
        {
            var top = new Panel { Dock = DockStyle.Top, Height = 42 };
            txtScanPath = new TextBox { Location = new Point(10, 9), Width = 320, Text = "K:\\" };
            btnScanFolder = new Button { Text = "选择文件夹…", Width = 95, Location = new Point(336, 8) };
            btnScan = new Button { Text = "扫描", Width = 55, Location = new Point(437, 8) };
            btnAdd = new Button { Text = "添加游戏(选Game.exe)", Width = 145, Location = new Point(498, 8) };
            btnSelectAll = new Button { Text = "全选", Width = 58, Location = new Point(649, 8) };
            btnStartAll = new Button { Text = "全部汉化", Width = 86, Location = new Point(713, 8), BackColor = Color.FromArgb(200, 255, 200) };
            btnRestore = new Button { Text = "一键还原选中", Width = 104, Location = new Point(805, 8) };
            cmbModel = new ComboBox { Location = new Point(915, 10), Width = 150, DropDownStyle = ComboBoxStyle.DropDownList };
            cmbDevice = new ComboBox { Location = new Point(1071, 10), Width = 250, DropDownStyle = ComboBoxStyle.DropDownList };
            btnRefreshModels = new Button { Text = "刷新模型", Width = 75, Location = new Point(1327, 8) };
            btnModelDir = new Button { Text = "模型目录…", Width = 85, Location = new Point(1408, 8) };
            btnStart = new Button { Text = "开始汉化选中", Width = 105, Location = new Point(1499, 8), BackColor = Color.FromArgb(210, 235, 255) };
            btnPause = new Button { Text = "暂停", Width = 60, Location = new Point(1610, 8) };
            btnStop = new Button { Text = "终止", Width = 60, Location = new Point(1676, 8), BackColor = Color.FromArgb(255, 220, 220) };
            top.Controls.AddRange(new Control[] { txtScanPath, btnScanFolder, btnScan, btnAdd, btnSelectAll, btnStartAll, btnRestore, cmbModel, cmbDevice, btnRefreshModels, btnModelDir, btnStart, btnPause, btnStop });
            DetectHardware();

            list = new ListView { Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, MultiSelect = true };
            list.Columns.Add("游戏目录", 920);
            list.Columns.Add("引擎", 70);
            list.Columns.Add("状态", 150);
            list.Columns.Add("数据大小", 90);

            var bottom = new Panel { Dock = DockStyle.Bottom, Height = 200 };
            progress = new ProgressBar { Dock = DockStyle.Top, Height = 18 };
            var statusBar = new Panel { Dock = DockStyle.Bottom, Height = 22 };
            lblStatus = new Label { Text = "就绪", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, ForeColor = Color.DarkBlue };
            statusBar.Controls.Add(lblStatus);
            log = new RichTextBox { Dock = DockStyle.Fill, ReadOnly = true, Font = new Font("Consolas", 9) };
            bottom.Controls.Add(log);
            bottom.Controls.Add(statusBar);
            bottom.Controls.Add(progress);
            progress.Dock = DockStyle.Bottom;
            log.Dock = DockStyle.Fill;

            var mid = new SplitContainer { Dock = DockStyle.Fill, Orientation = Orientation.Horizontal };
            mid.Panel1.Controls.Add(list);
            mid.Panel2.Controls.Add(bottom);
            mid.SplitterDistance = 380;

            Controls.Add(mid);
            Controls.Add(bottom);
            Controls.Add(top);

            btnScan.Click += (s, e) => { var p = txtScanPath.Text.Trim(); if (p != "") ScanRoot(p); };
            btnScanFolder.Click += (s, e) => ChooseScanFolder();
            btnAdd.Click += (s, e) => AddGame();
            btnSelectAll.Click += (s, e) => ToggleSelectAll();
            btnStartAll.Click += (s, e) => StartTranslate(true);
            btnRestore.Click += (s, e) => RestoreSelected();
            btnStart.Click += (s, e) => StartTranslate(false);
            btnRefreshModels.Click += (s, e) => LoadModels();
            btnModelDir.Click += (s, e) => ChooseModelDir();
            btnPause.Click += (s, e) => TogglePause();
            btnStop.Click += (s, e) => StopTranslate();
        }

        // ---------------- settings ----------------
        private string SettingsPath() { return Path.Combine(appDir, "settings.json"); }

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
        }

        private void SaveSettings()
        {
            try
            {
                var ser = new DataContractJsonSerializer(typeof(Settings));
                using (var fs = File.Create(SettingsPath())) ser.WriteObject(fs, settings);
            }
            catch (Exception ex) { Log("保存设置失败: " + ex.Message); }
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
            var ngl = settings.Device == "cpu" ? 0 : 99;
            Log("启动内置 llama（" + (settings.Device == "cpu" ? "CPU" : "GPU/CUDA") + "）：" + Path.GetFileName(modelPath));
            var psi = new ProcessStartInfo(server)
            {
                Arguments = "-m \"" + modelPath + "\" --host 127.0.0.1 --port " + settings.Port + " -c 4096 -ngl " + ngl + " -b 512 -ub 256 --no-webui",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
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
            while (sw.Elapsed < TimeSpan.FromSeconds(120))
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
                            return true;
                        }
                }
                catch { }
                Thread.Sleep(500);
            }
            Log("等待 llama 就绪超时（120秒）");
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
            Log("已添加：" + gi.Dir + " [" + gi.Kind + (gi.AlreadyCn ? ", 已汉化]" : "]"));
        }

        private GameItem Detect(string dir)
        {
            var www = Path.Combine(dir, "www");
            var data = Path.Combine(www, "data");
            string kind = null;
            if (File.Exists(Path.Combine(www, "js", "rpg_core.js")) && Directory.Exists(data)) kind = "MV";
            else if (File.Exists(Path.Combine(www, "js", "rmmz_core.js")) && Directory.Exists(data)) kind = "MZ";
            else if (File.Exists(Path.Combine(dir, "Game.rgss3a")) || (Directory.Exists(Path.Combine(dir, "Data")) && Directory.GetFiles(Path.Combine(dir, "Data"), "*.rvdata2").Length > 0))
                kind = "VXAce";
            if (kind == null) return null;

            long bytes = 0;
            try
            {
                if (kind == "VXAce")
                {
                    var arch = Path.Combine(dir, "Game.rgss3a");
                    if (File.Exists(arch)) bytes = new FileInfo(arch).Length;
                    else foreach (var f in Directory.GetFiles(Path.Combine(dir, "Data"), "*.rvdata2")) bytes += new FileInfo(f).Length;
                }
                else foreach (var f in Directory.GetFiles(data, "*.json")) bytes += new FileInfo(f).Length;
            }
            catch { }
            int cn = 0, kana = 0;
            try
            {
                IEnumerable<string> files;
                if (kind == "VXAce") files = Directory.GetFiles(Path.Combine(dir, "Data"), "*.rvdata2").Take(8);
                else files = Directory.GetFiles(data, "*.json").Take(8);
                foreach (var f in files)
                {
                    var t = File.ReadAllText(f, Encoding.UTF8);
                    foreach (var ch in t)
                    {
                        int c = (int)ch;
                        if (c >= 0x4e00 && c <= 0x9fff) cn++;
                        else if (c >= 0x3040 && c <= 0x30ff) kana++;
                    }
                }
            }
            catch { }
            return new GameItem { Dir = dir, Kind = kind, DataBytes = bytes, AlreadyCn = cn > 200 && cn > kana * 3 };
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
                BeginInvoke(new Action(() => { RefreshList(); lblStatus.Text = "扫描完成"; busy = false; }));
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
            foreach (ListViewItem it in list.Items)
            {
                var g = games[it.Index];
                var bak = Path.Combine(g.Dir, "data_原版备份");
                g.Status = g.AlreadyCn ? "已汉化(跳过)" : (Directory.Exists(bak) ? "有备份" : "待汉化");
                it.SubItems[2].Text = g.Status;
            }
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
                Log("已继续");
            }
            else
            {
                try { File.WriteAllText(flag, "1"); } catch (Exception ex) { Log("暂停失败: " + ex.Message); return; }
                paused = true;
                btnPause.Text = "继续";
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
            if (!EnsureLlama(modelPath)) { MessageBox.Show("内置 llama 启动失败，请查看日志"); return; }

            busy = true;
            btnStart.Enabled = false;
            btnStartAll.Enabled = false;
            var th = new Thread(() =>
            {
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
                else CopyDir(Path.Combine(g.Dir, "www", "data"), bak);
            }
            WriteRestoreBat(g.Dir);
            SetStatus(g, "汉化中…");
            var work = WorkDir();
            var psi = new ProcessStartInfo(nodePath)
            {
                Arguments = "\"" + Path.Combine(appDir, "game-pipeline.js") + "\" \"" + g.Dir + "\" \"" + modelName + "\" \"" + work + "\" " + settings.Port,
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
            SetStatus(g, "已完成");
            Log("完成: " + g.Dir);
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
                        var data = Path.Combine(g.Dir, "www", "data");
                        if (Directory.Exists(data)) Directory.Delete(data, true);
                        CopyDir(bak, data);
                    }
                    Log("已还原: " + g.Dir);
                    SetStatus(g, "已还原");
                }
                catch (Exception ex) { Log("还原失败: " + g.Dir + " " + ex.Message); }
            }
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
            if (File.Exists(bat)) return;
            var lines = new[]
            {
                "@echo off",
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
                "  if exist \"www\\data\" rmdir /s /q \"www\\data\"",
                "  mkdir \"www\\data\" >nul 2>&1",
                "  xcopy /e /i /y \"data_原版备份\\*\" \"www\\data\" >nul",
                ")",
                "echo.",
                "echo 还原完成！游戏数据已恢复为汉化前的原版。",
                "pause"
            };
            File.WriteAllLines(bat, lines, Encoding.GetEncoding(936));
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
