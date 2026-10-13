param(
  [Parameter(Mandatory = $true)][ValidateSet('chrome', 'edge')][string]$Browser,
  [Parameter(Mandatory = $true)][string]$Executable
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BrowserDebuggingWindow {
  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr window, uint message, IntPtr key, IntPtr data);
}
'@

$processName = if ($Browser -eq 'chrome') { 'chrome' } else { 'msedge' }
$expectedExecutable = "$processName.exe"
$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
if ([IO.Path]::GetFileName($resolvedExecutable) -ne $expectedExecutable) { throw 'Unsupported browser executable.' }
$inspectUrl = "${Browser}://inspect/#remote-debugging"
$windowCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Chrome_WidgetWin_1')
$editCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$sessionId = (Get-Process -Id $PID).SessionId

function Get-BrowserWindows {
  $processIds = @(Get-Process -Name $processName -ErrorAction SilentlyContinue |
    Where-Object { $_.SessionId -eq $sessionId } | ForEach-Object { $_.Id })
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children, $windowCondition)
  @($windows | Where-Object { $_.Current.ProcessId -in $processIds })
}

$previousWindows = @(Get-BrowserWindows | ForEach-Object { $_.Current.NativeWindowHandle })
# Chromium rejects chrome:// startup URLs. Open a new blank window, then use
# only that window's address bar; never type into an existing tab or another app.
# See chrome/browser/ui/startup/url_util.cc in the Chromium source.
# This is the interactive settings window the user requested to open.
Start-Process -FilePath $resolvedExecutable -ArgumentList '--new-window', 'about:blank' -WindowStyle Normal
$deadline = [DateTime]::UtcNow.AddSeconds(6)
$settingsWindow = $null
$address = $null
$value = $null
while ([DateTime]::UtcNow -lt $deadline -and $null -eq $address) {
  foreach ($window in @(Get-BrowserWindows)) {
    if ($window.Current.NativeWindowHandle -in $previousWindows) { continue }
    $edits = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCondition)
    foreach ($edit in $edits) {
      try {
        $pattern = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if ($pattern.Current.Value -eq 'about:blank' -and !$pattern.Current.IsReadOnly) {
          $settingsWindow = $window
          $address = $edit
          $value = $pattern
          break
        }
      } catch { }
    }
    if ($null -ne $address) { break }
  }
  if ($null -eq $address) { Start-Sleep -Milliseconds 100 }
}
if ($null -eq $address) { throw 'The new browser address bar is unavailable.' }

$address.SetFocus()
$value.SetValue($inspectUrl)
$handle = [IntPtr]$settingsWindow.Current.NativeWindowHandle
if (![BrowserDebuggingWindow]::PostMessage($handle, 0x0100, [IntPtr]13, [IntPtr]1)) { throw 'Navigation failed.' }
[void][BrowserDebuggingWindow]::PostMessage($handle, 0x0101, [IntPtr]13, [IntPtr]::new(-1073741823))
$deadline = [DateTime]::UtcNow.AddSeconds(3)
while ([DateTime]::UtcNow -lt $deadline) {
  if ($value.Current.Value -eq $inspectUrl -and $settingsWindow.Current.Name -match 'Inspect|\u68c0\u67e5|\u8c03\u8bd5|\u5f00\u53d1\u8005') {
    Write-Output 'debugging_page_opened'
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
throw 'The debugging settings page did not open.'
