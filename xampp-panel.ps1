# Reads or presses the MySQL Start/Stop button in the XAMPP Control Panel.
#
# The panel prints "MySQL shutdown unexpectedly" whenever mysqld goes away
# without its own Stop button having been pressed - it keeps no other record
# of who stopped it, and xampp-control.exe is a closed Delphi binary. So when
# the panel is watching MySQL, the launcher stops it through that button.
#
#   xampp-panel.ps1          -> "state=Stop" | "state=Start" | "state=none"
#   xampp-panel.ps1 -Click   -> "clicked" | "state=..." (button was not Stop)
#   xampp-panel.ps1 -Quit    -> "quit" | "busy" (a module still runs) | "state=none"
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
}
"@

$panel = Get-Process xampp-control -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $panel) { 'state=none'; exit 0 }

# Quitting the panel leaves whatever it started running with nothing watching
# it, so only quit once every module's button is back to Start.
if ($Quit) {
  $modules = [XamppPanel]::FindButtons($panel.Id, 'Start', 'Stop')
  if ($modules.Count -ne 5) { 'state=none'; exit 0 }
  if ($modules | Where-Object { [XamppPanel]::Caption($_) -eq 'Stop' }) { 'busy'; exit 0 }
  $quitButton = [XamppPanel]::FindButtons($panel.Id, 'Quit') | Select-Object -First 1
  if (-not $quitButton) { 'state=none'; exit 0 }
  if ([XamppPanel]::Press($quitButton)) { 'quit' } else { 'state=error' }
  exit 0
}

$button = [XamppPanel]::FindMysqlButton($panel.Id)
if ($button -eq [IntPtr]::Zero) { 'state=none'; exit 0 }

$caption = [XamppPanel]::Caption($button)
if (-not $Click -or $caption -ne 'Stop') { "state=$caption"; exit 0 }

if ([XamppPanel]::Press($button)) { 'clicked' } else { 'state=error' }
