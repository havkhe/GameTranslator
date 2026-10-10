using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace GameTranslatorV3.Core
{
    /// <summary>How one attempt ended.</summary>
    public enum AttemptResult
    {
        Completed,      // the pipeline reported DONE
        TimedOut,       // exceeded the total budget for this game
        Stalled,        // produced no output for far too long
        Failed,         // exited with a non-zero code
        Cancelled       // the user pressed 终止
    }

    public sealed class AttemptLog
    {
        public int Attempt;
        public AttemptResult Result;
        public int ExitCode;
        public TimeSpan Elapsed;
        public string LastLine;
        public string Reason;
    }

    public sealed class GameOutcome
    {
        public string Game;
        public bool Succeeded;
        public bool Skipped;
        public string SkipReason;
        public int AttemptsUsed;
        public TimeSpan Elapsed;
        public readonly List<AttemptLog> History = new List<AttemptLog>();
    }

    /// <summary>
    /// Runs the translation pipeline for one game with the guarantees a long batch needs:
    ///
    ///   * a game that fails is retried, up to MaxAttempts (default 3);
    ///   * after the last failure it is SKIPPED, recorded, and the batch moves on —
    ///     one broken title must never stop the queue;
    ///   * a game that exceeds its total time budget, or that produces no output at all
    ///     for StalledAfter, is killed and treated as a failed attempt rather than
    ///     being allowed to hang forever;
    ///   * everything is appended to errors.log and skips.log so the run can be audited
    ///     afterwards.
    ///
    /// The pipeline is a separate Node process, so the only reliable way to stop a hung
    /// stage is to kill that process; a timeout therefore kills the tree by PID and
    /// starts the next attempt cleanly. Per-entry retry lives inside the pipeline
    /// (attempt budget + per-entry validation); this class covers the layer above it,
    /// where a whole invocation can hang or crash.
    /// </summary>
    public sealed class PipelineRunner
    {
        public string NodeExe = @"D:\GameTranslator\node\node.exe";
        public string PipelineJs = @"D:\GameTranslator\game-pipeline.js";   // v3: pipeline/index.js
        public string WorkDir = @"D:\GameTranslator\work";
        public int Port = 18080;
        public string Model = "Galtransl-v4-4B-2601.gguf";
        public int MaxAttempts = 3;
        public TimeSpan GameBudget = TimeSpan.FromHours(3);
        public TimeSpan StalledAfter = TimeSpan.FromMinutes(10);

        public event Action<string> Output;                  // one line of pipeline output
        public event Action<string, string> AttemptFailed;   // game, reason

        private readonly object _logLock = new object();
        private Process _current;

        public PipelineRunner(string root)
        {
            if (!string.IsNullOrEmpty(root))
            {
                string node = Path.Combine(root, "node", "node.exe");
                if (File.Exists(node)) NodeExe = node;
                string js = Path.Combine(root, "game-pipeline.js");
                if (File.Exists(js)) PipelineJs = js;
            }
        }

        private void Log(string file, string text)
        {
            try
            {
                lock (_logLock)
                {
                    Directory.CreateDirectory(WorkDir);
                    File.AppendAllText(Path.Combine(WorkDir, file),
                        DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + text + Environment.NewLine,
                        Encoding.UTF8);
                }
            }
            catch { /* logging must never break a run */ }
        }

        public void LogError(string text) { Log("errors.log", text); }
        public void LogSkip(string text) { Log("skips.log", text); }

        /// <summary>Translate one game, retrying and then skipping as described above.</summary>
        public async Task<GameOutcome> RunAsync(string gameDir, string promptFile, CancellationToken cancel)
        {
            var outcome = new GameOutcome { Game = Path.GetFileName(gameDir.TrimEnd('\\', '/')) };
            var start = DateTime.UtcNow;

            for (int attempt = 1; attempt <= Math.Max(1, MaxAttempts); attempt++)
            {
                if (cancel.IsCancellationRequested) { outcome.Skipped = true; outcome.SkipReason = "用户终止"; return outcome; }

                var log = new AttemptLog { Attempt = attempt };
                var attemptStart = DateTime.UtcNow;
                var result = await RunOnceAsync(gameDir, promptFile, cancel,
                    r => { log.Result = r.Result; log.ExitCode = r.ExitCode; log.Reason = r.Reason; },
                    line => { log.LastLine = line; });
                log.Elapsed = DateTime.UtcNow - attemptStart;
                outcome.History.Add(log);
                outcome.AttemptsUsed = attempt;

                if (log.Result == AttemptResult.Completed)
                {
                    outcome.Succeeded = true;
                    Log("errors.log", "OK      " + outcome.Game + "  第 " + attempt + " 次尝试成功  用时 " + log.Elapsed);
                    return outcome;
                }
                if (log.Result == AttemptResult.Cancelled)
                {
                    outcome.Skipped = true; outcome.SkipReason = "用户终止"; return outcome;
                }

                string why = Describe(log);
                Raise(AttemptFailed, outcome.Game, why);
                Log("errors.log", "FAIL    " + outcome.Game + "  第 " + attempt + "/" + MaxAttempts + " 次：" + why);

                if (attempt < MaxAttempts)
                {
                    // Short backoff: the usual causes are a busy server or a transient
                    // crash, and restarting immediately tends to hit the same state.
                    try { await Task.Delay(TimeSpan.FromSeconds(15 * attempt), cancel); } catch { }
                }
            }

            outcome.Skipped = true;
            outcome.SkipReason = "重试 " + MaxAttempts + " 次仍未成功，已跳过以继续后续任务";
            outcome.Elapsed = DateTime.UtcNow - start;
            LogSkip(outcome.Game + "  已跳过：" + outcome.SkipReason + "  最后一次失败：" +
                    (outcome.History.Count > 0 ? Describe(outcome.History[outcome.History.Count - 1]) : "无记录"));
            return outcome;
        }

        private static string Describe(AttemptLog log)
        {
            switch (log.Result)
            {
                case AttemptResult.TimedOut: return "超过时间预算 " + Format(log.Elapsed) + "，已强制结束";
                case AttemptResult.Stalled: return "无输出超过阈值，判定卡死并强制结束（最后一行：" + Short(log.LastLine) + "）";
                case AttemptResult.Failed: return "退出码 " + log.ExitCode + "（最后一行：" + Short(log.LastLine) + "）";
                default: return log.Reason ?? log.Result.ToString();
            }
        }

        private static string Short(string s)
        {
            if (string.IsNullOrEmpty(s)) return "无";
            s = s.Trim();
            return s.Length <= 120 ? s : s.Substring(0, 120) + "…";
        }

        private static string Format(TimeSpan t)
        {
            if (t.TotalHours >= 1) return t.Hours + " 小时 " + t.Minutes + " 分";
            return Math.Round(t.TotalMinutes, 1) + " 分";
        }

        private class AttemptOutcome
        {
            public AttemptResult Result;
            public int ExitCode;
            public string Reason;
        }

        /// <summary>
        /// Quote one argument for the Windows command line.
        ///
        /// ProcessStartInfo.ArgumentList does not exist in the .NET Framework 4.x build
        /// this project compiles with (it is a .NET Core API), so arguments are joined
        /// by hand. Getting this wrong matters here: game paths contain spaces,
        /// parentheses, brackets and Japanese text.
        /// </summary>
        public static string Quote(string arg)
        {
            if (arg == null) return "\"\"";
            if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"', '(', ')', '[', ']', '&', '^', '%', '!' }) < 0)
                return arg;
            var sb = new StringBuilder();
            sb.Append('"');
            int backslashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\') { backslashes++; continue; }
                if (c == '"')
                {
                    // backslashes before a quote must be doubled, and the quote escaped
                    sb.Append('\\', backslashes * 2 + 1);
                    sb.Append('"');
                    backslashes = 0;
                    continue;
                }
                if (backslashes > 0) { sb.Append('\\', backslashes); backslashes = 0; }
                sb.Append(c);
            }
            if (backslashes > 0) sb.Append('\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }

        public static string Join(string[] args)
        {
            var sb = new StringBuilder();
            foreach (var a in args)
            {
                if (sb.Length > 0) sb.Append(' ');
                sb.Append(Quote(a));
            }
            return sb.ToString();
        }

        private async Task<AttemptOutcome> RunOnceAsync(string gameDir, string promptFile, CancellationToken cancel,
            Action<AttemptOutcome> report, Action<string> sawLine)
        {
            var outcome = new AttemptOutcome();
            var argv = new List<string> { PipelineJs, gameDir, WorkDir, Port.ToString(), "translate" };
            if (!string.IsNullOrEmpty(promptFile) && File.Exists(promptFile)) argv.Add(promptFile);

            var psi = new ProcessStartInfo
            {
                FileName = NodeExe,
                Arguments = Join(argv.ToArray()),
                WorkingDirectory = Path.GetDirectoryName(PipelineJs),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };

            Process proc;
            try { proc = Process.Start(psi); }
            catch (Exception ex)
            {
                outcome.Result = AttemptResult.Failed;
                outcome.ExitCode = -1;
                outcome.Reason = "无法启动管线：" + ex.Message;
                report(outcome);
                return outcome;
            }
            _current = proc;

            var lastOutput = DateTime.UtcNow;
            var finished = new TaskCompletionSource<int>();
            var stderr = new StringBuilder();

            proc.OutputDataReceived += (s, e) =>
            {
                if (e.Data == null) return;
                lastOutput = DateTime.UtcNow;
                sawLine(e.Data);
                Raise(Output, e.Data);
            };
            proc.ErrorDataReceived += (s, e) =>
            {
                if (e.Data == null) return;
                lastOutput = DateTime.UtcNow;
                if (stderr.Length < 4000) stderr.AppendLine(e.Data);
            };
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            proc.EnableRaisingEvents = true;
            proc.Exited += (s, e) => finished.TrySetResult(proc.ExitCode);

            var start = DateTime.UtcNow;
            var cancelRegistration = cancel.Register(() => { try { KillTree(proc); } catch { } });

            // Poll rather than wait in one block: this is where the two "do not hang"
            // guarantees are enforced.
            while (!finished.Task.IsCompleted)
            {
                var waited = await Task.WhenAny(finished.Task, Task.Delay(2000));
                if (waited == finished.Task) break;

                if (cancel.IsCancellationRequested)
                {
                    KillTree(proc);
                    outcome.Result = AttemptResult.Cancelled;
                    break;
                }
                var idle = DateTime.UtcNow - lastOutput;
                if (idle > StalledAfter)
                {
                    KillTree(proc);
                    outcome.Result = AttemptResult.Stalled;
                    outcome.Reason = "无输出 " + Format(idle);
                    break;
                }
                if (DateTime.UtcNow - start > GameBudget)
                {
                    KillTree(proc);
                    outcome.Result = AttemptResult.TimedOut;
                    break;
                }
            }

            if (outcome.Result == AttemptResult.Cancelled) { cancelRegistration.Dispose(); report(outcome); return outcome; }

            try { await Task.WhenAny(finished.Task, Task.Delay(10000)); } catch { }
            cancelRegistration.Dispose();

            int code = 0;
            try { code = finished.Task.IsCompleted ? finished.Task.Result : -1; } catch { code = -1; }
            outcome.ExitCode = code;
            if (outcome.Result != AttemptResult.Stalled && outcome.Result != AttemptResult.TimedOut)
                outcome.Result = code == 0 ? AttemptResult.Completed : AttemptResult.Failed;
            if (outcome.Result == AttemptResult.Failed && stderr.Length > 0 && string.IsNullOrEmpty(outcome.Reason))
                outcome.Reason = stderr.ToString().Trim();

            _current = null;
            report(outcome);
            return outcome;
        }

        /// <summary>Kill the process and its children. Never by name: only this PID tree.</summary>
        public static void KillTree(Process proc)
        {
            if (proc == null) return;
            // The process may already have finished, which is the ordinary case when the
            // window closes after a run completes. taskkill reports a non-zero exit then,
            // and that must not be treated as a failure.
            try { if (proc.HasExited) return; } catch { return; }
            try
            {
                var killer = Process.Start(new ProcessStartInfo
                {
                    FileName = "taskkill",
                    Arguments = "/PID " + proc.Id + " /T /F",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                });
                if (killer != null)
                {
                    killer.WaitForExit(5000);
                    try { killer.StandardOutput.ReadToEnd(); killer.StandardError.ReadToEnd(); } catch { }
                    try { killer.Dispose(); } catch { }
                }
            }
            catch { }
            // The process can exit between the check above and taskkill running, and
            // Kill() then throws; both outcomes are already what we wanted.
            try { if (!proc.HasExited) proc.Kill(); } catch { }
            try { proc.Dispose(); } catch { }
        }

        public void StopCurrent()
        {
            var p = _current;
            if (p != null) KillTree(p);
        }

        private int _llamaPid;

        /// <summary>Remember the model server this runner launched, so Dispose can stop it.</summary>
        public void RememberLlamaProcess(int pid) { _llamaPid = pid; }

        public bool IsRunning { get { return _current != null; } }

        /// <summary>
        /// Release everything this runner started. Called when the window closes.
        ///
        /// Without this, the pipeline survived closing the UI: it is a separate Node
        /// process, so closing a window does not end it, and the result the user saw was
        /// a translation task that kept running with no way to stop it because the only
        /// control that stops it had gone. Killing the tree is the reliable form — the
        /// pipeline itself spawns Ruby for VX Ace work.
        /// </summary>
        public void Dispose()
        {
            StopCurrent();
            if (_llamaPid > 0)
            {
                // Only the server THIS runner started, identified by PID. Killing by the
                // name llama-server would also take down a server the user started on
                // purpose, or one the old v2 GUI owns.
                try
                {
                    var killer = Process.Start(new ProcessStartInfo
                    {
                        FileName = "taskkill",
                        Arguments = "/PID " + _llamaPid + " /T /F",
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true
                    });
                    if (killer != null) killer.WaitForExit(5000);
                }
                catch { }
                _llamaPid = 0;
            }
        }

        private void Raise(Action<string> handler, string a) { if (handler != null) handler(a); }
        private void Raise(Action<string, string> handler, string a, string b) { if (handler != null) handler(a, b); }
    }
}
