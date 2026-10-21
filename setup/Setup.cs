// CapetLocal-Setup.exe: extracts the embedded installer (install.ps1 + plugin) and runs it.
// Built by build-setup.ps1 with the C# compiler that ships with Windows (.NET Framework 4).
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

[assembly: AssemblyTitle("Installation IA locale")]
[assembly: AssemblyProduct("IA locale pour Paseo (Capet Local)")]
[assembly: AssemblyVersion("0.1.0.0")]

static class Setup
{
    static int Main(string[] args)
    {
        Console.Title = "Installation IA locale";
        Console.OutputEncoding = Encoding.UTF8;
        Console.WriteLine("IA locale pour Paseo : installation");
        Console.WriteLine("Tout s'installe tout seul : Paseo, l'agent, le moteur et le modèle conseillé pour ta carte.");

        string dir = Path.Combine(Path.GetTempPath(), "CapetLocal-Setup");
        try
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            Directory.CreateDirectory(dir);
            using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (ZipArchive zip = new ZipArchive(payload, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string path = Path.GetFullPath(Path.Combine(dir, entry.FullName));
                    if (!path.StartsWith(dir, StringComparison.OrdinalIgnoreCase)) continue;
                    if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(path); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(path));
                    entry.ExtractToFile(path, true);
                }
            }
        }
        catch (Exception e)
        {
            Console.WriteLine("Impossible de préparer l'installation : " + e.Message);
            Console.WriteLine("Appuie sur Entrée pour fermer.");
            Console.ReadLine();
            return 1;
        }

        StringBuilder line = new StringBuilder("-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(dir, "install.ps1") + "\"");
        // Quote only values with spaces: powershell -File reads a quoted "-SkipPagefile" as a
        // plain string, not a switch, and the script stops before its first line.
        foreach (string a in args)
        {
            string arg = a.Replace("\"", "");
            line.Append(arg.IndexOf(' ') >= 0 ? " \"" + arg + "\"" : " " + arg);
        }
        string powershell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
        ProcessStartInfo start = new ProcessStartInfo(powershell, line.ToString());
        start.UseShellExecute = false;
        using (Process p = Process.Start(start))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }
}
