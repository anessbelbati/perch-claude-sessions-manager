# Perch Desk: what the programs under its sessions use.
# The app sends one line: an answer number, then program numbers. This answers with one line: every program under
# those (them included), its name, memory and processor time, what kind of program it is, and the ports it listens
# on. It only reads; it never changes or stops anything. A program's command line is read only to tell what the
# program is (an MCP server, a known dev tool) and never leaves this script: what goes out is a kind and a short
# name from a fixed shape, never the line itself.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

public static class PerchProcs {
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("ntdll.dll")] private static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
  [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int ret);
  [DllImport("iphlpapi.dll")] private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool sorted, int family, int cls, uint reserved);

  private class Row { public uint Pid; public uint Ppid; public string Name; public long Created; public double Cpu; public ulong Ws; public ulong Priv; public string Kind; public string Label; }
  private class Seen { public long Created; public string Kind; public string Label; }
  // what a program is, worked out once per program: its command line is not read again
  private static readonly Dictionary<uint, Seen> known = new Dictionary<uint, Seen>();

  // dev tools known by name: the only words besides MCP package names that ever leave this script
  private static readonly HashSet<string> TOOLS = new HashSet<string>(new string[] {
    "vite", "next", "nuxt", "astro", "remix", "webpack", "webpack-dev-server", "parcel", "esbuild", "rollup", "turbo", "nx",
    "http-server", "live-server", "wrangler", "uvicorn", "gunicorn", "hypercorn", "flask", "http.server", "hugo",
    "jekyll", "gatsby", "expo", "metro", "storybook", "json-server", "nodemon", "vitest", "jest", "playwright", "cypress",
    "ngrok", "cloudflared", "convex", "supabase", "firebase", "prisma", "drizzle-kit", "tsx", "ts-node", "electron",
    "streamlit", "gradio", "jupyter", "ollama", "docker", "docker-compose", "pytest", "tsc", "eslint", "prettier",
    "npm", "pnpm", "yarn", "bun", "deno", "git", "rg", "uv", "pip", "cargo", "go", "dotnet", "java", "gradle", "rails",
    "django", "runserver", "lighthouse", "puppeteer", "chrome", "msedge", "ffmpeg", "python", "node" });
  private static readonly HashSet<string> RUNNERS = new HashSet<string>(new string[] { "npm", "pnpm", "yarn", "bun" });
  private static readonly Regex MCP = new Regex("mcp|modelcontextprotocol", RegexOptions.IgnoreCase);
  private static readonly Regex CLAUDE = new Regex(@"[\\/]claude(\.exe)?""?(\s|$)|@anthropic-ai[\\/]+claude-code", RegexOptions.IgnoreCase);
  private static readonly Regex PACKAGE = new Regex(@"node_modules[\\/]+((?:@[a-z0-9._-]+[\\/]+)?[a-z0-9._-]+)", RegexOptions.IgnoreCase);
  private static readonly Regex SAFE = new Regex(@"^@?[a-z0-9][a-z0-9._-]{0,40}(/[a-z0-9][a-z0-9._-]{0,40})?$");
  private static readonly Regex SCRIPT = new Regex(@"^[a-z0-9][a-z0-9:_-]{0,23}$");
  private static readonly Regex KEYLIKE = new Regex(@"[a-z0-9]{20,}|key|token|secret|pass|auth|bearer|sk-", RegexOptions.IgnoreCase);
  private static readonly string[] ENDS = new string[] { ".js", ".cjs", ".mjs", ".ts", ".py", ".exe", ".cmd", ".ps1", ".bat" };

  /** A word fit to leave this script: lower case, no version, no file ending, a package's shape, nothing like a key. */
  private static string Clean(string word) {
    if (string.IsNullOrEmpty(word)) return "";
    string w = word.ToLowerInvariant().Replace('\\', '/').Trim('/', ',', ';');
    int at = w.LastIndexOf('@');
    if (at > 0) w = w.Substring(0, at);
    foreach (string end in ENDS) if (w.EndsWith(end)) { w = w.Substring(0, w.Length - end.Length); break; }
    if (!SAFE.IsMatch(w) || KEYLIKE.IsMatch(w)) return "";
    return w;
  }

  /** The last part of a path; a package's scope is kept. */
  private static string Leaf(string word) {
    string w = word.Replace('\\', '/');
    if (w.StartsWith("@") && w.IndexOf('/') == w.LastIndexOf('/')) return w;
    int s = w.LastIndexOf('/');
    return s >= 0 ? w.Substring(s + 1) : w;
  }

  private static void Classify(string cmd, out string kind, out string label) {
    kind = ""; label = "";
    if (string.IsNullOrEmpty(cmd)) return;
    string[] words = cmd.Split(new char[] { ' ', '\t', '"', '\'' }, StringSplitOptions.RemoveEmptyEntries);
    string pkg = "";
    foreach (Match m in PACKAGE.Matches(cmd)) pkg = m.Groups[1].Value;
    // Claude Code itself, a second one started by a command: its line may name MCP settings, it is no MCP server
    if (CLAUDE.IsMatch(cmd) && words.Length > 0 && (Leaf(words[0]).ToLowerInvariant().StartsWith("claude") || pkg.ToLowerInvariant().Replace('\\', '/') == "@anthropic-ai/claude-code")) {
      kind = "claude"; label = "claude"; return;
    }
    if (MCP.IsMatch(cmd)) {
      kind = "mcp";
      string l = Clean(pkg);
      if (l.IndexOf("mcp") < 0 && l.IndexOf("modelcontextprotocol") < 0) l = "";
      if (l == "") {
        foreach (string w in words) {
          string c = Clean(Leaf(w));
          if (c != "" && (c.IndexOf("mcp") >= 0 || c.IndexOf("modelcontextprotocol") >= 0)) { l = c; break; }
        }
      }
      label = l;
      return;
    }
    string found = "";
    for (int i = 0; i < words.Length && found == ""; i++) {
      string c = Clean(Leaf(words[i]));
      // the program itself names nothing: node, python and the like run something else
      if (i == 0 && (c == "node" || c == "python" || c == "python3" || c == "pythonw" || c == "cmd" || c == "bash" || c == "powershell" || c == "pwsh" || c == "sh")) continue;
      if (c == "npm-cli") c = "npm";
      if (c == "manage" && i + 1 < words.Length && words[i + 1] == "runserver") c = "django";
      if (TOOLS.Contains(c) && c != "node" && c != "python") found = c;
    }
    if (found == "") { string p = Clean(pkg); if (p == "npm-cli") p = "npm"; if (TOOLS.Contains(p)) found = p; }
    if (found == "") return;
    kind = "tool";
    label = found;
    // npm run dev, and the like: the script's name, when it is a plain short word
    if (RUNNERS.Contains(found)) {
      for (int i = 0; i + 1 < words.Length; i++) {
        if (words[i] != "run") continue;
        string s = words[i + 1].ToLowerInvariant();
        if (SCRIPT.IsMatch(s) && !KEYLIKE.IsMatch(s)) label = found + " run " + s;
        break;
      }
    }
  }

  private static string CommandLine(IntPtr h) {
    int size = 8192;
    for (int attempt = 0; attempt < 2; attempt++) {
      IntPtr buf = Marshal.AllocHGlobal(size);
      try {
        int ret;
        // 60: the command line, as Windows keeps it for the program (Windows 8.1 and later)
        int status = NtQueryInformationProcess(h, 60, buf, size, out ret);
        if (status == 0) {
          int length = (ushort)Marshal.ReadInt16(buf);
          IntPtr text = Marshal.ReadIntPtr(buf, IntPtr.Size);
          return length > 0 && text != IntPtr.Zero ? Marshal.PtrToStringUni(text, length / 2) : "";
        }
        if (ret <= size || ret > (1 << 20)) return "";
        size = ret;
      } finally { Marshal.FreeHGlobal(buf); }
    }
    return "";
  }

  /** What kind of program it is: worked out from its command line the first time it is seen, kept after that. */
  private static void Kind(Row r) {
    Seen s;
    if (known.TryGetValue(r.Pid, out s) && s.Created == r.Created) { r.Kind = s.Kind; r.Label = s.Label; return; }
    string kind = "", label = "";
    IntPtr h = OpenProcess(0x1000, false, r.Pid);
    if (h != IntPtr.Zero) {
      try { Classify(CommandLine(h), out kind, out label); } finally { CloseHandle(h); }
    }
    s = new Seen(); s.Created = r.Created; s.Kind = kind; s.Label = label;
    known[r.Pid] = s;
    r.Kind = kind; r.Label = label;
  }

  private static IntPtr table = IntPtr.Zero;
  private static int tableSize = 1 << 20;
  /**
   * Every program on the machine, from one call: the list Task Manager reads. Its number, its parent's, its name,
   * when it started, its processor time, its working set, and its private working set (what Task Manager's Memory
   * column shows). The layout is that of 64-bit Windows; null elsewhere.
   */
  private static Dictionary<uint, Row> All() {
    if (IntPtr.Size != 8) return null;
    for (int attempt = 0; attempt < 6; attempt++) {
      if (table == IntPtr.Zero) table = Marshal.AllocHGlobal(tableSize);
      int ret;
      int status = NtQuerySystemInformation(5, table, tableSize, out ret);
      if (status == unchecked((int)0xC0000004)) {
        Marshal.FreeHGlobal(table);
        table = IntPtr.Zero;
        tableSize = Math.Max(ret, tableSize) + (256 << 10);
        continue;
      }
      if (status != 0) return null;
      Dictionary<uint, Row> all = new Dictionary<uint, Row>();
      int at = 0;
      for (int guard = 0; guard < 100000; guard++) {
        IntPtr e = IntPtr.Add(table, at);
        Row r = new Row();
        r.Pid = (uint)Marshal.ReadInt64(e, 80);
        r.Ppid = (uint)Marshal.ReadInt64(e, 88);
        r.Priv = (ulong)Marshal.ReadInt64(e, 8);
        r.Created = Marshal.ReadInt64(e, 32);
        r.Cpu = (Marshal.ReadInt64(e, 40) + Marshal.ReadInt64(e, 48)) / 10000.0;
        r.Ws = (ulong)Marshal.ReadInt64(e, 144);
        int length = (ushort)Marshal.ReadInt16(e, 56);
        IntPtr text = Marshal.ReadIntPtr(e, 64);
        r.Name = length > 0 && text != IntPtr.Zero ? Marshal.PtrToStringUni(text, length / 2) : "";
        r.Kind = ""; r.Label = "";
        all[r.Pid] = r;
        int next = Marshal.ReadInt32(e, 0);
        if (next <= 0) break;
        at += next;
      }
      return all;
    }
    return null;
  }

  private static void Str(StringBuilder b, string s) {
    b.Append('"');
    foreach (char ch in s) {
      if (ch == '"' || ch == '\\') b.Append('\\').Append(ch);
      else if (ch < 0x20 || ch > 0x7e) b.Append("\\u").Append(((int)ch).ToString("x4"));
      else b.Append(ch);
    }
    b.Append('"');
  }

  /** The TCP ports the programs listen on: [port, program]. */
  private static List<uint[]> Listeners(Dictionary<uint, Row> rows) {
    List<uint[]> found = new List<uint[]>();
    HashSet<ulong> had = new HashSet<ulong>();
    foreach (int family in new int[] { 2, 23 }) {
      int size = 0;
      GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, 3, 0);
      if (size <= 0) continue;
      size += 4096;
      IntPtr buf = Marshal.AllocHGlobal(size);
      try {
        if (GetExtendedTcpTable(buf, ref size, false, family, 3, 0) != 0) continue;
        int n = Marshal.ReadInt32(buf);
        int rowSize = family == 2 ? 24 : 56;
        int portAt = family == 2 ? 8 : 20;
        int pidAt = family == 2 ? 20 : 52;
        for (int i = 0; i < n; i++) {
          IntPtr row = IntPtr.Add(buf, 4 + i * rowSize);
          uint pid = (uint)Marshal.ReadInt32(row, pidAt);
          if (!rows.ContainsKey(pid)) continue;
          int raw = Marshal.ReadInt32(row, portAt);
          uint port = (uint)(((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF));
          if (had.Add(((ulong)pid << 16) | port)) found.Add(new uint[] { port, pid });
        }
      } finally { Marshal.FreeHGlobal(buf); }
    }
    return found;
  }

  public static string Sample(string line) {
    string[] parts = (line ?? "").Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
    uint ask = 0;
    List<uint> roots = new List<uint>();
    for (int i = 0; i < parts.Length; i++) {
      uint v;
      if (!uint.TryParse(parts[i], out v)) continue;
      if (i == 0) ask = v; else if (v > 4) roots.Add(v);
    }
    Dictionary<uint, Row> all = All();
    if (all == null) return "{\"q\":" + ask + ",\"error\":\"no list of programs\"}";
    Dictionary<uint, List<uint>> kids = new Dictionary<uint, List<uint>>();
    foreach (Row r in all.Values) {
      if (r.Pid == r.Ppid) continue;
      List<uint> list;
      if (!kids.TryGetValue(r.Ppid, out list)) { list = new List<uint>(); kids[r.Ppid] = list; }
      list.Add(r.Pid);
    }
    Dictionary<uint, Row> rows = new Dictionary<uint, Row>();
    Queue<uint> queue = new Queue<uint>();
    foreach (uint r in roots) {
      Row row;
      if (rows.ContainsKey(r) || !all.TryGetValue(r, out row)) continue;
      rows[r] = row;
      queue.Enqueue(r);
    }
    while (queue.Count > 0 && rows.Count < 3000) {
      uint pid = queue.Dequeue();
      List<uint> list;
      if (!kids.TryGetValue(pid, out list)) continue;
      Row me = rows[pid];
      foreach (uint k in list) {
        Row row = all[k];
        if (rows.ContainsKey(k)) continue;
        // a parent's number can go to a new program once it ends: a child older than its parent is not its child
        if (me.Created > 0 && row.Created > 0 && row.Created < me.Created) continue;
        rows[k] = row;
        queue.Enqueue(k);
      }
    }
    foreach (Row r in rows.Values) Kind(r);
    List<uint> gone = new List<uint>();
    foreach (uint pid in known.Keys) if (!all.ContainsKey(pid)) gone.Add(pid);
    foreach (uint pid in gone) known.Remove(pid);

    StringBuilder b = new StringBuilder(8192);
    b.Append("{\"q\":").Append(ask).Append(",\"p\":[");
    bool first = true;
    foreach (Row r in rows.Values) {
      if (!first) b.Append(',');
      first = false;
      b.Append('[').Append(r.Pid).Append(',').Append(r.Ppid).Append(',');
      Str(b, r.Name);
      b.Append(',').Append(r.Created > 0 ? (r.Created - 116444736000000000L) / 10000L : 0L);
      b.Append(',').Append(r.Ws).Append(',').Append(r.Priv).Append(',');
      b.Append(r.Cpu.ToString("0.#", CultureInfo.InvariantCulture)).Append(',');
      Str(b, r.Kind);
      b.Append(',');
      Str(b, r.Label);
      b.Append(']');
    }
    b.Append("],\"l\":[");
    first = true;
    foreach (uint[] l in Listeners(rows)) {
      if (!first) b.Append(',');
      first = false;
      b.Append('[').Append(l[0]).Append(',').Append(l[1]).Append(']');
    }
    b.Append("],\"n\":").Append(all.Count).Append('}');
    return b.ToString();
  }
}
'@
[Console]::Out.WriteLine('{"ready":1}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try { $answer = [PerchProcs]::Sample($line) }
  catch { $answer = '{"error":"' + ($_.Exception.Message -replace '[^\w .,:-]', ' ') + '"}' }
  [Console]::Out.WriteLine($answer)
  [Console]::Out.Flush()
}
