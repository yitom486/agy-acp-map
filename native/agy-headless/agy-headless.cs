// Windows-only generic headless launcher (C# fallback, no Go required).
//
// Usage: agy-headless.exe <target-exe> [args...]
// Spawns the target with CREATE_NO_WINDOW and forwards stdin/stdout/stderr
// unchanged, propagating the child's exit code.
//
// Build (no SDK needed, ships with Windows):
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:winexe /optimize+ /nologo /out:dist\agy-headless.exe native\agy-headless\agy-headless.cs
//
// Notes:
// - /target:winexe marks this binary as a GUI-subsystem program so Windows
//   never allocates a conhost.exe for the shim itself.
// - CreateNoWindow=true makes the CUI child (e.g. agy.exe) inherit no console.
// - CommandLine is built with MSVCRT quoting rules; the Go implementation
//   (main.go, argv passthrough) stays the primary build when Go is available.
// - Written in C# 5 compatible syntax for the inbox Framework 4.0 compiler.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

static class AgyHeadless
{
    static int Main(string[] args)
    {
        if (args == null || args.Length < 1)
        {
            Console.Error.WriteLine("agy-headless: missing target executable");
            return 64;
        }

        string target = args[0];
        string arguments = BuildCommandLine(args, 1);

        ProcessStartInfo startInfo = new ProcessStartInfo();
        startInfo.FileName = target;
        startInfo.Arguments = arguments;
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = true;
        startInfo.RedirectStandardInput = true;
        startInfo.RedirectStandardOutput = true;
        startInfo.RedirectStandardError = true;

        Process child;
        try
        {
            child = Process.Start(startInfo);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("agy-headless: failed to start target: " + ex.Message);
            return 1;
        }

        if (child == null)
        {
            Console.Error.WriteLine("agy-headless: failed to start target");
            return 1;
        }

        Stream parentIn = Console.OpenStandardInput();
        Stream parentOut = Console.OpenStandardOutput();
        Stream parentErr = Console.OpenStandardError();

        Task tIn = Task.Factory.StartNew(delegate { Pump(parentIn, child.StandardInput.BaseStream, true); });
        Task tOut = Task.Factory.StartNew(delegate { Pump(child.StandardOutput.BaseStream, parentOut, false); });
        Task tErr = Task.Factory.StartNew(delegate { Pump(child.StandardError.BaseStream, parentErr, false); });

        child.WaitForExit();
        try
        {
            Task.WaitAll(new Task[] { tOut, tErr }, 5000);
        }
        catch
        {
            // Best effort drain; exit code below is what matters.
        }

        return child.ExitCode;
    }

    static void Pump(Stream src, Stream dst, bool closeDstOnEof)
    {
        try
        {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = src.Read(buffer, 0, buffer.Length)) > 0)
            {
                dst.Write(buffer, 0, read);
                dst.Flush();
            }
        }
        catch
        {
            // Broken pipe on teardown is expected; never crash the shim.
        }
        finally
        {
            if (closeDstOnEof)
            {
                try { dst.Close(); } catch { }
            }
        }
    }

    static string BuildCommandLine(string[] args, int start)
    {
        StringBuilder sb = new StringBuilder();
        for (int i = start; i < args.Length; i++)
        {
            if (i > start)
            {
                sb.Append(' ');
            }
            sb.Append(QuoteArg(args[i]));
        }
        return sb.ToString();
    }

    // MSVCRT quoting: wrap in "..." when needed, escape embedded quotes and
    // the backslashes preceding them (plus trailing backslashes).
    static string QuoteArg(string value)
    {
        if (value == null)
        {
            return "\"\"";
        }
        if (value.Length == 0)
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
}
