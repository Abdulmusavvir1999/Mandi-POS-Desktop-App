# Reads or presses the MySQL Start/Stop button in the XAMPP Control Panel.
#
# The panel prints "MySQL shutdown unexpectedly" whenever mysqld goes away
# without its own Stop button having been pressed - it keeps no other record
# of who stopped it, and xampp-control.exe is a closed Delphi binary. So when
# the panel is watching MySQL, the launcher stops it through that button.
#
#   xampp-panel.ps1          -> "state=Stop" | "state=Start" | "state=none"
#   xampp-panel.ps1 -Click   -> "clicked" | "state=..." (button was not Stop)
#   xampp-panel.ps1 -Quit    -> "quit" | "quit-forced" | "busy" (a module still runs) | "state=none"
#
# Quit crashes the panel ("Exception EAccessViolation ... Read of address
# 00000042") whenever it cannot write xampp-control.ini, which the XAMPP
# installer leaves read-only for non-admins: FormDestroy frees the modules,
# SaveSettings fails and shows an error box, and the status timer - still
# running behind that box - touches the freed modules. setup.ps1 grants write
# access; until it has run, -Quit ends the panel directly instead, which loses
# nothing because every module is already stopped by then.
param([switch]$Click, [switch]$Quit)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class XamppPanel {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);

  static string Text(IntPtr hwnd) {
    var sb = new StringBuilder(64);
    GetWindowText(hwnd, sb, sb.Capacity);
    return sb.ToString();
  }

  // The five module rows (Apache, MySQL, FileZilla, Mercury, Tomcat) each have
  // one Start/Stop button and no other button carries either caption, so the
  // second one from the top is MySQL's. The module names are TLabels, which
  // have no window handle and cannot be matched on directly.
  // Every child window of the panel whose caption is one of the given ones,
  // top to bottom.
  public static List<IntPtr> FindButtons(int pid, params string[] captions) {
    var found = new List<KeyValuePair<int, IntPtr>>();
    EnumWindows((top, _) => {
      uint owner;
      GetWindowThreadProcessId(top, out owner);
      if (owner != pid) return true;
      EnumChildWindows(top, (child, __) => {
        if (Array.IndexOf(captions, Text(child)) >= 0) {
          RECT r;
          GetWindowRect(child, out r);
          found.Add(new KeyValuePair<int, IntPtr>(r.Top, child));
        }
        return true;
      }, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
    found.Sort((a, b) => a.Key.CompareTo(b.Key));
    return found.ConvertAll(p => p.Value);
  }

  public static IntPtr FindMysqlButton(int pid) {
    var buttons = FindButtons(pid, "Start", "Stop");
    // Any other count means a module is hidden or the layout changed, and the
    // second button may not be MySQL's - better to press nothing.
    return buttons.Count == 5 ? buttons[1] : IntPtr.Zero;
  }

  public static string Caption(IntPtr hwnd) { return Text(hwnd); }

  // WM_COMMAND/BN_CLICKED to the parent is what a real click ends in, and the
  // VCL routes it to the button's OnClick. Unlike BM_CLICK it still works when
  // the panel is minimised or sitting in the tray.
  public static bool Press(IntPtr button) {
    IntPtr result;
    IntPtr wParam = (IntPtr)(GetDlgCtrlID(button) & 0xFFFF);
    return SendMessageTimeout(GetParent(button), 0x0111, wParam, button, 0x0002, 15000, out result) != IntPtr.Zero;
  }

  // Quit tears the panel down, so post the click rather than wait inside it.
  public static bool PressAsync(IntPtr button) {
    IntPtr wParam = (IntPtr)(GetDlgCtrlID(button) & 0xFFFF);
    return PostMessage(GetParent(button), 0x0111, wParam, button);
  }

  // A visible dialog box (#32770) means the panel is showing an error.
  public static bool HasDialog(int pid) {
    bool found = false;
    EnumWindows((top, _) => {
      uint owner;
      GetWindowThreadProcessId(top, out owner);
      if (owner != pid || !IsWindowVisible(top)) return true;
      var sb = new StringBuilder(32);
      GetClassName(top, sb, sb.Capacity);
      if (sb.ToString() == "#32770") { found = true; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

# An elevated panel hides its buttons from us, so prefer one we can work.
$panels = @(Get-Process xampp-control -ErrorAction SilentlyContinue)
if (-not $panels) { 'state=none'; exit 0 }
$panel = $panels | Where-Object { [XamppPanel]::FindButtons($_.Id, 'Start', 'Stop').Count -eq 5 } | Select-Object -First 1
if (-not $panel) { $panel = $panels[0] }

# Quitting the panel leaves whatever it started running with nothing watching
# it, so only quit once every module's button is back to Start.
if ($Quit) {
  $modules = [XamppPanel]::FindButtons($panel.Id, 'Start', 'Stop')
  if ($modules.Count -ne 5) { 'state=none'; exit 0 }
  if ($modules | Where-Object { [XamppPanel]::Caption($_) -eq 'Stop' }) { 'busy'; exit 0 }
  $quitButton = [XamppPanel]::FindButtons($panel.Id, 'Quit') | Select-Object -First 1
  if (-not $quitButton) { 'state=none'; exit 0 }

  # Same user and integrity as the panel (its buttons answered above), so
  # this is the access its SaveSettings will get.
  $ini = Join-Path (Split-Path $panel.Path) 'xampp-control.ini'
  $canSave = $true
  try { [IO.File]::Open($ini, 'OpenOrCreate', 'ReadWrite', 'ReadWrite').Close() } catch { $canSave = $false }

  if ($canSave -and [XamppPanel]::PressAsync($quitButton)) {
    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline) {
      if ($panel.WaitForExit(100)) { 'quit'; exit 0 }
      if ([XamppPanel]::HasDialog($panel.Id)) { break }
    }
  }

  # Not saveable, or it errored or hung on the way out: end it before any
  # crash box shows, along with Windows Error Reporting if it already began.
  try { Stop-Process -Id $panel.Id -Force } catch { }
  Get-CimInstance Win32_Process -Filter "Name='WerFault.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "-p\s+$($panel.Id)\b" } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch { } }
  if ($panel.WaitForExit(3000)) { 'quit-forced' } else { 'state=error' }
  exit 0
}

$button = [XamppPanel]::FindMysqlButton($panel.Id)
if ($button -eq [IntPtr]::Zero) { 'state=none'; exit 0 }

$caption = [XamppPanel]::Caption($button)
if (-not $Click -or $caption -ne 'Stop') { "state=$caption"; exit 0 }

if ([XamppPanel]::Press($button)) { 'clicked' } else { 'state=error' }
