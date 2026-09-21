// Console-flash watchdog (Windows-only test helper, winexe).
//
// Simulates a GUI parent like Zed: this binary itself has no console, then it
// spawns a child the "naive" way (no CREATE_NO_WINDOW, unless --no-window is
// given) and watches whether any *new* visible console window appears.
//
// Usage:
//   flash-watchdog.exe [--no-window] [--observe <ms>]
//     [--stdin <file>] [--stdout <file>] [--stderr <file>]
//     -- <child> [args...]
//
// The child is always killed after the observation window; JSON verdict goes
// to this process's stdout (keep child stdout/stderr in files, not pipes).
//
// C# 5 syntax only: builds with the inbox Framework 4.0 csc.exe.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class FlashWatchdog
{
    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]
    static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")]
    static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(
        IntPtr processHandle, int processInformationClass,
        IntPtr processInformation, int processInformationLength,
        out int returnLength);
    [DllImport("kernel32.dll")]
    static extern IntPtr OpenProcess(int desiredAccess, bool inheritHandle, int processId);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    const int PROCESS_QUERY_INFORMATION = 0x0400;

    // Parent pid via NTDLL (no WMI/System.Management dependency).
    static int GetParentPid(int pid)
    {
        IntPtr h = OpenProcess(PROCESS_QUERY_INFORMATION, false, pid);
        if (h == IntPtr.Zero)
        {
            return -1;
        }
        try
        {
            int size = IntPtr.Size * 6;
            IntPtr pbi = Marshal.AllocHGlobal(size);
            try
            {
                int len;
                int status = NtQueryInformationProcess(h, 0, pbi, size, out len);
                if (status != 0)
                {
                    return -1;
                }
                // PROCESS_BASIC_INFORMATION: [..., UniqueProcessId, InheritedFromUniqueProcessId]
                long parent = Marshal.ReadIntPtr(pbi, IntPtr.Size * 5).ToInt64();
                return (int)parent;
            }
            finally
            {
                Marshal.FreeHGlobal(pbi);
            }
        }
        finally
        {
            CloseHandle(h);
        }
    }

    static bool IsDescendant(int pid, int rootPid)
    {
        int cur = pid;
        for (int i = 0; i < 32 && cur > 0; i++)
        {
            if (cur == rootPid)
            {
                return true;
            }
            cur = GetParentPid(cur);
            if (cur < 0)
            {
                return false;
            }
        }
        return false;
    }

    sealed class WinInfo
    {
        public long Hwnd;
        public long Pid;
        public string Title = string.Empty;
        public string Process = string.Empty;
    }

    static int Main(string[] args)
    {
        bool noWindow = false;
        int observeMs = 3000;
        string stdinFile = null;
        string stdoutFile = null;
        string stderrFile = null;
        List<string> childArgs = new List<string>();
        bool sep = false;

        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (!sep && a == "--")
            {
                sep = true;
                continue;
            }
            if (!sep && a == "--no-window")
            {
                noWindow = true;
                continue;
            }
            if (!sep && a == "--observe" && i + 1 < args.Length)
            {
                int.TryParse(args[++i], out observeMs);
                continue;
            }
            if (!sep && a == "--stdin" && i + 1 < args.Length)
            {
                stdinFile = args[++i];
                continue;
            }
            if (!sep && a == "--stdout" && i + 1 < args.Length)
            {
                stdoutFile = args[++i];
                continue;
            }
            if (!sep && a == "--stderr" && i + 1 < args.Length)
            {
                stderrFile = args[++i];
                continue;
            }
            childArgs.Add(a);
        }

        if (childArgs.Count == 0)
        {
            Console.Error.WriteLine("usage: flash-watchdog.exe [options] -- <child> [args...]");
            return 64;
        }
        if (observeMs < 500)
        {
            observeMs = 500;
        }
        if (observeMs > 60000)
        {
            observeMs = 60000;
        }

        Dictionary<long, WinInfo> baseline = SnapshotConsoleWindows();
        DateTime baselineUtc = DateTime.UtcNow;
        Dictionary<int, byte> baselineHosts = SnapshotConsoleHosts();

        Process child = null;
        int childExit = -1;
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = childArgs[0];
            psi.Arguments = BuildCommandLine(childArgs, 1);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = noWindow;
            psi.RedirectStandardInput = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            child = Process.Start(psi);
        }
        catch (Exception ex)
        {
            Console.WriteLine("{\"error\":" + JsonQuote("spawn failed: " + ex.Message) + "}");
            return 1;
        }

        // Background pumps: stdin feed is held OPEN (Zed keeps stdio alive for
        // the whole session); stdout/stderr drain to files (or nul) so a
        // chatty child never blocks on a full pipe.
        Stream outDst = OpenSink(stdoutFile);
        Stream errDst = OpenSink(stderrFile);
        if (outDst == null)
        {
            outDst = Stream.Null;
        }
        if (errDst == null)
        {
            errDst = Stream.Null;
        }
        Stream childIn = null;
        Stream childOut = null;
        Stream childErr = null;
        try { childIn = child.StandardInput.BaseStream; } catch { }
        try { childOut = child.StandardOutput.BaseStream; } catch { }
        try { childErr = child.StandardError.BaseStream; } catch { }

        string stdinCopy = stdinFile;
        Stream stdinDst = childIn;
        Stream stdoutSrc = childOut;
        Stream stderrSrc = childErr;
        Stream stdoutDst = outDst;
        Stream stderrDst = errDst;
        Thread tIn = new Thread(delegate()
        {
            try
            {
                if (stdinDst == null)
                {
                    return;
                }
                if (stdinCopy != null && File.Exists(stdinCopy))
                {
                    byte[] bytes = File.ReadAllBytes(stdinCopy);
                    stdinDst.Write(bytes, 0, bytes.Length);
                    stdinDst.Flush();
                }
                // Hold stdin open: closing it would EOF a stdio server early.
            }
            catch
            {
                // Child may have exited already; observation below still counts.
            }
        });
        Thread tOut = new Thread(delegate() { Pump(stdoutSrc, stdoutDst, false); });
        Thread tErr = new Thread(delegate() { Pump(stderrSrc, stderrDst, false); });
        tIn.IsBackground = true;
        tOut.IsBackground = true;
        tErr.IsBackground = true;
        tIn.Start();
        tOut.Start();
        tErr.Start();

        List<WinInfo> fresh = new List<WinInfo>();
        Dictionary<long, byte> seen = new Dictionary<long, byte>();
        foreach (long h in baseline.Keys)
        {
            seen[h] = 1;
        }

        int elapsed = 0;
        while (elapsed < observeMs)
        {
            Thread.Sleep(40);
            elapsed += 40;
            Dictionary<long, WinInfo> now = SnapshotConsoleWindows();
            foreach (KeyValuePair<long, WinInfo> kv in now)
            {
                if (!seen.ContainsKey(kv.Key))
                {
                    seen[kv.Key] = 1;
                    fresh.Add(kv.Value);
                }
            }
            if (child.HasExited)
            {
                // Give a doomed console a beat to disappear/appear, then stop.
                Thread.Sleep(300);
                Dictionary<long, WinInfo> last = SnapshotConsoleWindows();
                foreach (KeyValuePair<long, WinInfo> kv in last)
                {
                    if (!seen.ContainsKey(kv.Key))
                    {
                        seen[kv.Key] = 1;
                        fresh.Add(kv.Value);
                    }
                }
                break;
            }
        }

        // Attribute BEFORE killing: exited pids can't be walked afterwards.
        int selfPid = Process.GetCurrentProcess().Id;
        Dictionary<int, byte> hostsNow = SnapshotConsoleHosts();
        List<int> hostDelta = new List<int>();
        List<int> hostOurs = new List<int>();
        foreach (int pid in hostsNow.Keys)
        {
            if (baselineHosts.ContainsKey(pid))
            {
                continue;
            }
            // PID reuse guard: only count hosts actually born inside the window.
            bool bornHere = false;
            try
            {
                Process p = Process.GetProcessById(pid);
                bornHere = p.StartTime.ToUniversalTime() >= baselineUtc.AddSeconds(-2);
            }
            catch
            {
                // Exited during inspection; cannot attribute — stays ambient.
                continue;
            }
            if (!bornHere)
            {
                continue;
            }
            hostDelta.Add(pid);
            if (IsDescendant(pid, selfPid))
            {
                hostOurs.Add(pid);
            }
        }
        // Attribute fresh windows to our tree as well (names resolved once).
        List<WinInfo> freshOurs = new List<WinInfo>();
        foreach (WinInfo w in fresh)
        {
            try
            {
                Process p = Process.GetProcessById((int)w.Pid);
                w.Process = p.ProcessName + "|" + w.Process;
            }
            catch
            {
                w.Process = "?|" + w.Process;
            }
            if (IsDescendant((int)w.Pid, selfPid))
            {
                freshOurs.Add(w);
            }
        }

        try
        {
            if (!child.HasExited)
            {
                child.Kill();
            }
            child.WaitForExit(3000);
        }
        catch
        {
        }
        try
        {
            childExit = child.HasExited ? child.ExitCode : -1;
        }
        catch
        {
            childExit = -1;
        }
        try
        {
            // Best-effort drain join; the JSON verdict below is what matters.
            tIn.Join(1000);
            tOut.Join(2000);
            tErr.Join(2000);
        }
        catch
        {
        }
        CloseQuiet(outDst, stdoutFile);
        CloseQuiet(errDst, stderrFile);

        StringBuilder json = new StringBuilder();
        json.Append("{\"newWindows\":[");
        AppendWindows(json, freshOurs);
        json.Append("],\"newWindowsAmbient\":[");
        AppendWindows(json, fresh);
        json.Append("],\"conhostDelta\":[");
        for (int i = 0; i < hostOurs.Count; i++)
        {
            if (i > 0)
            {
                json.Append(',');
            }
            json.Append(hostOurs[i]);
        }
        json.Append("],\"conhostDeltaAmbient\":[");
        for (int i = 0; i < hostDelta.Count; i++)
        {
            if (i > 0)
            {
                json.Append(',');
            }
            json.Append(hostDelta[i]);
        }
        json.Append("],\"childExit\":" + childExit + "}");
        Console.WriteLine(json.ToString());
        return 0;
    }

    static void Pump(Stream src, Stream dst, bool closeDstOnEof)
    {
        if (src == null)
        {
            return;
        }
        try
        {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = src.Read(buffer, 0, buffer.Length)) > 0)
            {
                if (dst != null)
                {
                    dst.Write(buffer, 0, read);
                    dst.Flush();
                }
            }
        }
        catch
        {
            // Broken pipe on teardown is expected; never fail the observation.
        }
        finally
        {
            if (closeDstOnEof && dst != null)
            {
                try { dst.Close(); } catch { }
            }
        }
    }

    static Stream OpenSink(string file)
    {
        if (file == null)
        {
            return null;
        }
        try
        {
            return new FileStream(file, FileMode.Create, FileAccess.Write, FileShare.Read);
        }
        catch
        {
            return null;
        }
    }

    static void CloseQuiet(Stream s, string file)
    {
        if (s == null || file == null)
        {
            return;
        }
        try { s.Flush(); } catch { }
        try { s.Close(); } catch { }
    }

    // Env opt-in (FLASHWATCH_ALL=1): track ALL new visible top-level windows,
    // not just ConsoleWindowClass. Used to diagnose Terminal-hosted consoles.
    static bool TrackAllWindows()
    {
        string v = Environment.GetEnvironmentVariable("FLASHWATCH_ALL");
        return v == "1" || (v != null && v.ToLowerInvariant() == "true");
    }

    static Dictionary<long, WinInfo> SnapshotConsoleWindows()
    {
        bool all = TrackAllWindows();
        Dictionary<long, WinInfo> out_ = new Dictionary<long, WinInfo>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr lp)
        {
            if (!IsWindowVisible(hwnd))
            {
                return true;
            }
            StringBuilder cls = new StringBuilder(256);
            if (GetClassName(hwnd, cls, cls.Capacity) == 0)
            {
                return true;
            }
            if (!all && cls.ToString() != "ConsoleWindowClass")
            {
                return true;
            }
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            StringBuilder title = new StringBuilder(512);
            GetWindowText(hwnd, title, title.Capacity);
            WinInfo info = new WinInfo();
            info.Hwnd = hwnd.ToInt64();
            info.Pid = pid;
            info.Title = title.ToString();
            // Process name resolved once at report time, never in the hot poll.
            info.Process = cls.ToString();
            out_[info.Hwnd] = info;
            return true;
        }, IntPtr.Zero);
        return out_;
    }

    static Dictionary<int, byte> SnapshotConsoleHosts()
    {
        Dictionary<int, byte> set = new Dictionary<int, byte>();
        string[] names = new string[] { "conhost", "openconsole" };
        for (int i = 0; i < names.Length; i++)
        {
            try
            {
                Process[] ps = Process.GetProcessesByName(names[i]);
                for (int j = 0; j < ps.Length; j++)
                {
                    try { set[ps[j].Id] = 1; }
                    catch { }
                }
            }
            catch
            {
            }
        }
        return set;
    }

    static string BuildCommandLine(List<string> args, int start)
    {
        StringBuilder sb = new StringBuilder();
        for (int i = start; i < args.Count; i++)
        {
            if (i > start)
            {
                sb.Append(' ');
            }
            sb.Append(QuoteArg(args[i]));
        }
        return sb.ToString();
    }

    static string QuoteArg(string value)
    {
        if (value == null || value.Length == 0)
        {
            return "\"\"";
        }
        bool needsQuotes = false;
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '"')
            {
                needsQuotes = true;
                break;
            }
        }
        if (!needsQuotes)
        {
            return value;
        }
        StringBuilder sb = new StringBuilder();
        sb.Append('"');
        int backslashes = 0;
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c == '\\')
            {
                backslashes++;
            }
            else if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
                backslashes = 0;
            }
            else
            {
                if (backslashes > 0)
                {
                    sb.Append('\\', backslashes);
                    backslashes = 0;
                }
                sb.Append(c);
            }
        }
        if (backslashes > 0)
        {
            sb.Append('\\', backslashes * 2);
        }
        sb.Append('"');
        return sb.ToString();
    }

    static void AppendWindows(StringBuilder json, List<WinInfo> list)
    {
        for (int i = 0; i < list.Count; i++)
        {
            if (i > 0)
            {
                json.Append(',');
            }
            WinInfo w = list[i];
            json.Append("{\"hwnd\":" + w.Hwnd + ",\"pid\":" + w.Pid +
                ",\"title\":" + JsonQuote(w.Title) +
                ",\"process\":" + JsonQuote(w.Process) + "}");
        }
    }

    static string JsonQuote(string value)
    {
        if (value == null)
        {
            return "null";
        }
        StringBuilder sb = new StringBuilder();
        sb.Append('"');
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c == '"')
            {
                sb.Append("\\\"");
            }
            else if (c == '\\')
            {
                sb.Append("\\\\");
            }
            else if (c == '\n')
            {
                sb.Append("\\n");
            }
            else if (c == '\r')
            {
                sb.Append("\\r");
            }
            else if (c == '\t')
            {
                sb.Append("\\t");
            }
            else if (c < 0x20)
            {
                sb.Append("\\u");
                sb.Append(((int)c).ToString("x4"));
            }
            else
            {
                sb.Append(c);
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}
