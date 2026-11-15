// Adapted from slimeball2026/DSH-Coach-mode, MIT. See THIRD_PARTY_NOTICES.md.
function psLiteral(value) { return String.fromCharCode(39) + String(value).replaceAll(String.fromCharCode(39), String.fromCharCode(39,39)) + String.fromCharCode(39); }

export function captureScript(options) {
  const { target, outPath, maxWidth, maxHeight, selfPid } = options
  const blocked = Array.isArray(options.blocked) ? options.blocked : []
  const blockedTitles = Array.isArray(options.blockedTitles) ? options.blockedTitles : []
  const blockedList = blocked.length === 0 ? '@()' : `@(${blocked.map(psLiteral).join(', ')})`
  const blockedTitleList = blockedTitles.length === 0
    ? '@()'
    : `@(${blockedTitles.map(psLiteral).join(', ')})`
  return `
$ErrorActionPreference = 'Stop'
# The script arrives as UTF-16LE base64 through stdin, so paths and window titles
# retain Unicode without depending on PowerShell 5.1 file encoding or command length.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
function Write-Result($value) { $value | ConvertTo-Json -Compress -Depth 4 }
try {
  Add-Type -AssemblyName System.Drawing
  if (-not ('CoachShot' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CoachShot {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT rect, int size);
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public static void EnableDpiAwareness() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) { return; } } catch { }
    try { SetProcessDPIAware(); } catch { }
  }
  // Visible frame bounds: excludes the invisible DWM resize/shadow margin that
  // GetWindowRect includes (measured: 7px left/right/bottom on Windows 10).
  public static bool TryGetFrame(IntPtr hWnd, out RECT rect) {
    rect = new RECT();
    int hr = DwmGetWindowAttribute(hWnd, 9, out rect, Marshal.SizeOf(typeof(RECT)));
    if (hr == 0 && rect.Right > rect.Left && rect.Bottom > rect.Top) return true;
    return GetWindowRect(hWnd, out rect);
  }
  // Which process owns the window visible at this screen point? Returns -1 if none.
  // GA_ROOT = 2, so a child control resolves to its top-level window.
  public static int OwnerPidAt(int x, int y) {
    POINT p = new POINT();
    p.X = x; p.Y = y;
    IntPtr hit = WindowFromPoint(p);
    if (hit == IntPtr.Zero) return -1;
    IntPtr root = GetAncestor(hit, 2);
    if (root == IntPtr.Zero) root = hit;
    uint pid;
    GetWindowThreadProcessId(root, out pid);
    return (int)pid;
  }
}
'@
  }
  [CoachShot]::EnableDpiAwareness()

  $target = ${psLiteral(target)}
  $outPath = ${psLiteral(outPath)}
  $maxWidth = ${maxWidth}
  $maxHeight = ${maxHeight}
  $blocked = ${blockedList}
  $blockedTitles = ${blockedTitleList}
  $selfPid = ${selfPid}
  $listOnly = ${options.listOnly === true ? '$true' : '$false'}
  $windowId = ${psLiteral(options.windowId || '')}

  $script:wins = New-Object System.Collections.ArrayList
  $callback = [CoachShot+EnumProc]{
    param($hWnd, $lParam)
    if (-not [CoachShot]::IsWindowVisible($hWnd)) { return $true }
    $buffer = New-Object System.Text.StringBuilder 1024
    if ([CoachShot]::GetWindowTextW($hWnd, $buffer, 1024) -le 0) { return $true }
    $owner = [uint32]0
    [void][CoachShot]::GetWindowThreadProcessId($hWnd, [ref]$owner)
    $processName = ''
    $processStart = ''
    try {
      $proc = Get-Process -Id $owner -ErrorAction Stop
      $processName = $proc.ProcessName
      $processStart = $proc.StartTime.ToUniversalTime().Ticks.ToString()
    } catch { return $true }
    [void]$script:wins.Add([pscustomobject]@{
      hwnd = $hWnd
      pid = [int]$owner
      process = $processName
      title = $buffer.ToString()
      id = ([string]$owner + ':' + $hWnd.ToInt64().ToString() + ':' + $processStart)
    })
    return $true
  }
  [void][CoachShot]::EnumWindows($callback, [IntPtr]::Zero)

  $candidates = New-Object System.Collections.ArrayList
  $ignored = New-Object System.Collections.ArrayList
  foreach ($window in $script:wins) {
    $name = $window.process.ToLower()
    $title = $window.title.ToLower()
    $blockedByTitle = $false
    foreach ($marker in $blockedTitles) {
      if ($title.Contains($marker)) { $blockedByTitle = $true; break }
    }
    if (($blocked -contains $name) -or $blockedByTitle -or ($window.pid -eq $selfPid)) {
      [void]$ignored.Add($window)
    } else {
      [void]$candidates.Add($window)
    }
  }

  $matched = @()
  if ($target -match '^pid:([0-9]+)$') {
    $wantedPid = [int]$Matches[1]
    $matched = @($candidates | Where-Object { $_.pid -eq $wantedPid })
  } else {
    $needle = $target.ToLower()
    $best = 99
    foreach ($window in $candidates) {
      $name = $window.process.ToLower()
      $title = $window.title.ToLower()
      $score = 99
      if ($name -eq $needle) { $score = 0 }
      elseif ($name.Contains($needle)) { $score = 1 }
      elseif ($title.Contains($needle)) { $score = 2 }
      if ($score -lt $best) { $best = $score; $matched = @($window) }
      elseif ($score -eq $best -and $score -lt 99) { $matched += $window }
    }
  }
  $choices = @($matched | Sort-Object process, title, id | Select-Object -First 20 | ForEach-Object {
    [pscustomobject]@{ id = $_.id; pid = $_.pid; process = $_.process; title = $_.title }
  })
  if ($listOnly) {
    Write-Result @{ ok = $true; windows = $choices }
    exit 0
  }
  $pick = $null
  # Capture always requires a previously discovered exact window identity.
  foreach ($window in $candidates) {
    if ($windowId -ne '' -and $window.id -eq $windowId) { $pick = $window; break }
  }
  if ($null -eq $pick) {
    Write-Result @{ ok = $false; error = 'window_changed'; candidates = $choices }
    exit 0
  }

  if ([CoachShot]::IsIconic($pick.hwnd)) {
    Write-Result @{ ok = $false; error = 'window_minimized'; title = $pick.title; process = $pick.process; pid = $pick.pid }
    exit 0
  }

  $rect = New-Object CoachShot+RECT
  if (-not [CoachShot]::TryGetFrame($pick.hwnd, [ref]$rect)) {
    Write-Result @{ ok = $false; error = 'no_rect'; title = $pick.title; process = $pick.process; pid = $pick.pid }
    exit 0
  }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 1 -or $height -le 1) {
    Write-Result @{ ok = $false; error = 'zero_size'; title = $pick.title; process = $pick.process; pid = $pick.pid }
    exit 0
  }

  # ---- v0.4.4: capture the WINDOW, not the screen pixels under its rectangle ----
  # CopyFromScreen (v0.4.3) returns whatever is painted at those coordinates, so any
  # window stacked on top silently becomes the "evidence". PrintWindow asks the target
  # window to render itself into our bitmap, so occlusion no longer matters.
  function Test-FlatBitmap($bmp) {
    $seen = @{}
    $stepX = [Math]::Max(1, [int]($bmp.Width / 16))
    $stepY = [Math]::Max(1, [int]($bmp.Height / 16))
    for ($x = 0; $x -lt $bmp.Width; $x += $stepX) {
      for ($y = 0; $y -lt $bmp.Height; $y += $stepY) {
        $seen[$bmp.GetPixel($x, $y).ToArgb()] = $true
        if ($seen.Count -gt 1) { return $false }
      }
    }
    return $true
  }

  # How many of 9 sample points inside the target rect are covered by ANOTHER process?
  # Used only to decide whether falling back to screen pixels would be honest.
  function Get-OccludedCount($r, $ownPid) {
    $covered = 0
    foreach ($fx in 0.15, 0.5, 0.85) {
      foreach ($fy in 0.15, 0.5, 0.85) {
        $px = [int]($r.Left + ($r.Right - $r.Left) * $fx)
        $py = [int]($r.Top + ($r.Bottom - $r.Top) * $fy)
        $owner = [CoachShot]::OwnerPidAt($px, $py)
        if ($owner -ne -1 -and $owner -ne $ownPid) { $covered++ }
      }
    }
    return $covered
  }

  $bitmap = $null
  $method = ''
  $occluded = 0

  # 1) Preferred: the window renders itself. Unaffected by stacking order.
  $attempt = New-Object System.Drawing.Bitmap $width, $height
  $attemptGraphics = [System.Drawing.Graphics]::FromImage($attempt)
  $hdc = $attemptGraphics.GetHdc()
  # 2 = PW_RENDERFULLCONTENT (Windows 8.1+): required for DirectComposition /
  # hardware-accelerated windows, where plain PrintWindow returns an empty frame.
  $printed = $false
  try { $printed = [CoachShot]::PrintWindow($pick.hwnd, [IntPtr]$hdc, 2) } catch { $printed = $false }
  $attemptGraphics.ReleaseHdc([IntPtr]$hdc)
  $attemptGraphics.Dispose()
  if ($printed -and -not (Test-FlatBitmap $attempt)) {
    $bitmap = $attempt
    $method = 'printwindow'
  } else {
    # PrintWindow failed or produced a flat frame (common for GPU-drawn windows).
    $attempt.Dispose()
    $occluded = Get-OccludedCount $rect $pick.pid
    if ($occluded -gt 0) {
      # Falling back to screen pixels here would capture the covering window.
      # Refuse instead of returning someone else's pixels as evidence.
      Write-Result @{
        ok = $false
        error = 'occluded'
        title = $pick.title
        process = $pick.process
        pid = $pick.pid
        covered = $occluded
      }
      exit 0
    }
    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size $width, $height))
    $graphics.Dispose()
    $method = 'screen'
  }

  # A single flat color almost always means the capture failed
  # (minimized / exclusive fullscreen / DRM / GPU black frame), so it must not count as evidence.
  if (Test-FlatBitmap $bitmap) {
    $bitmap.Dispose()
    Write-Result @{ ok = $false; error = 'blank_image'; title = $pick.title; process = $pick.process; pid = $pick.pid; method = $method }
    exit 0
  }

  $scale = 1.0
  if ($width -gt $maxWidth) { $scale = [Math]::Min($scale, $maxWidth / $width) }
  if ($height -gt $maxHeight) { $scale = [Math]::Min($scale, $maxHeight / $height) }
  $final = $bitmap
  if ($scale -lt 1.0) {
    $scaledWidth = [int][Math]::Max(1, [Math]::Round($width * $scale))
    $scaledHeight = [int][Math]::Max(1, [Math]::Round($height * $scale))
    $final = New-Object System.Drawing.Bitmap $scaledWidth, $scaledHeight
    $scaled = [System.Drawing.Graphics]::FromImage($final)
    $scaled.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $scaled.DrawImage($bitmap, 0, 0, $scaledWidth, $scaledHeight)
    $scaled.Dispose()
    $bitmap.Dispose()
  }

  $directory = [System.IO.Path]::GetDirectoryName($outPath)
  if (-not [System.IO.Directory]::Exists($directory)) { [void][System.IO.Directory]::CreateDirectory($directory) }
  $final.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $savedWidth = $final.Width
  $savedHeight = $final.Height
  $final.Dispose()

  Write-Result @{
    ok = $true
    path = $outPath
    width = $savedWidth
    height = $savedHeight
    sourceWidth = $width
    sourceHeight = $height
    pid = $pick.pid
    process = $pick.process
    title = $pick.title
    windowId = $pick.id
    method = $method
  }
} catch {
  Write-Result @{
    ok = $false
    error = 'exception'
    message = $_.Exception.Message
    line = $_.InvocationInfo.ScriptLineNumber
    source = $_.InvocationInfo.Line
  }
}
`
}
