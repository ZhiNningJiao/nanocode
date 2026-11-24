<#
  phone-input-client.ps1 - Windows half of the phone input board.

  Runs in the owner's own interactive desktop session (started at logon by a
  scheduled task, see README.md). It long-polls the WSL half
  (tools/phone-input/phone-input.mjs) on 127.0.0.1 for one paste instruction
  at a time, puts the text on the clipboard, sends Ctrl+V to the foreground
  window (plus Enter when asked) and acks the result.

  It never talks to the chat service, never writes the text anywhere except
  the clipboard and keeps no log. Windows PowerShell 5.1, ASCII-only file.

    powershell -NoProfile -Sta -ExecutionPolicy Bypass -File phone-input-client.ps1 [-Port 9497] [-KeyFile <path>]
    powershell -NoProfile -Sta -ExecutionPolicy Bypass -File phone-input-client.ps1 -SelfCheck
#>
param(
  # Must match the WSL half's config "port" (default 9497 there too).
  [int]$Port = 9497,
  # Same shared key as the WSL half's keyFile; a per-user file.
  [string]$KeyFile = (Join-Path $env:LOCALAPPDATA 'PhoneInput\key.txt'),
  # Print version / desktop state / whether /next answers, paste nothing.
  [switch]$SelfCheck
)

# Any unhandled error stops the script (the scheduled task restarts it).
$ErrorActionPreference = 'Stop'
# Catch typos in variable names instead of silently using $null.
Set-StrictMode -Version 2

# Header that carries the shared key (same name as KEY_HEADER in phone-input.mjs).
$HeaderName = 'X-Phone-Input-Key'
# The WSL half listens on loopback only; WSL2 forwards Windows localhost into WSL.
$Base = "http://127.0.0.1:$Port"
# How long the WSL half may hold one /next request open, and our socket timeout above it.
$LongPollMs = 25000
$LongPollTimeoutMs = 35000

# Clipboard and SendKeys live in WinForms.
Add-Type -AssemblyName System.Windows.Forms
# Small native helper: is the owner's desktop the one receiving input right now?
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PhoneInputDesk {
  [DllImport("user32.dll", SetLastError = true)]
  static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")]
  static extern bool CloseDesktop(IntPtr desk);
  [DllImport("user32.dll")]
  static extern IntPtr GetForegroundWindow();
  // "" when pasting is possible, else a short reason. OpenInputDesktop with
  // DESKTOP_SWITCHDESKTOP (0x0100) fails while the workstation is locked, at
  // the logon screen or on a UAC secure desktop.
  public static string Blocker() {
    if (!Environment.UserInteractive) return "not_user_interactive";
    IntPtr d = OpenInputDesktop(0, false, 0x0100);
    if (d == IntPtr.Zero) return "input_desktop_unavailable";
    CloseDesktop(d);
    if (GetForegroundWindow() == IntPtr.Zero) return "no_foreground_window";
    return "";
  }
}
'@

# One HTTP call to the WSL half. Returns @{ Status = <int>; Body = <string> }.
function Invoke-PhoneInput([string]$Method, [string]$PathAndQuery, [string]$Body, [int]$TimeoutMs) {
  # Plain HttpWebRequest: no IE engine, full control over proxy and encoding.
  $req = [System.Net.HttpWebRequest]::Create($Base + $PathAndQuery)
  $req.Method = $Method
  # Loopback must never go through a system proxy.
  $req.Proxy = $null
  # Connect/response timeout and read timeout, in milliseconds.
  $req.Timeout = $TimeoutMs
  $req.ReadWriteTimeout = $TimeoutMs
  # The shared key; the WSL half answers 401 without it.
  $req.Headers.Add($HeaderName, $script:Key)
  if ($Body) {
    # Request body (only /ack) is sent as UTF-8 JSON.
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $req.ContentType = 'application/json'
    $req.ContentLength = $bytes.Length
    $stream = $req.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
  }
  try {
    $resp = $req.GetResponse()
  } catch {
    # Non-2xx statuses arrive as a WebException that still carries the response;
    # dig it out of PowerShell's wrapper. No response at all = connection error: rethrow.
    $we = $_.Exception
    while ($we -and -not ($we -is [System.Net.WebException])) { $we = $we.InnerException }
    if ($we -and $we.Response) { $resp = $we.Response } else { throw }
  }
  try {
    # Bodies are ASCII-only JSON (non-ASCII is \uXXXX-escaped), UTF-8 decoding is just the safe default.
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
    return @{ Status = [int]$resp.StatusCode; Body = $reader.ReadToEnd() }
  } finally {
    $resp.Close()
  }
}

# Put text on the clipboard as Unicode text. Another app may hold the
# clipboard open for a moment, so retry briefly before giving up.
function Set-ClipboardText([string]$Text) {
  for ($i = 0; $i -lt 10; $i++) {
    try {
      [System.Windows.Forms.Clipboard]::SetText($Text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
      return
    } catch {
      Start-Sleep -Milliseconds 50
    }
  }
  throw 'clipboard_busy'
}

# Read the shared key (whitespace/newline around it is ignored).
$script:Key = (Get-Content -LiteralPath $KeyFile -Raw).Trim()

if ($SelfCheck) {
  # Read-only self check: nothing is put on the clipboard, no key is pressed, nothing is dequeued.
  Write-Output ('PowerShell ' + $PSVersionTable.PSVersion)
  Write-Output ('Apartment ' + [System.Threading.Thread]::CurrentThread.ApartmentState)
  Write-Output ('UserInteractive ' + [Environment]::UserInteractive)
  $why = [PhoneInputDesk]::Blocker()
  Write-Output ('Desktop ' + $(if ($why) { $why } else { 'ok' }))
  try {
    # probe=1 asks the WSL half for its queue length only; it hands out nothing.
    $r = Invoke-PhoneInput 'GET' '/next?probe=1' $null 5000
    Write-Output ('next ' + $r.Status + ' ' + $r.Body)
  } catch {
    Write-Output ('next unreachable: ' + $_.Exception.Message)
  }
  exit 0
}

# Only one client per logon session (a second start just exits).
$mutex = New-Object System.Threading.Mutex($false, 'Local\NanocodePhoneInput')
if (-not $mutex.WaitOne(0)) { exit 0 }

# Seconds to wait after a connection error; doubles up to 30, reset on success.
$backoff = 1
while ($true) {
  # Locked / not on the owner's desktop: do not take anything. Instructions
  # left in the queue expire on the WSL side and get the not-pasted reaction.
  if ([PhoneInputDesk]::Blocker()) { Start-Sleep -Seconds 2; continue }

  try {
    # Long-poll: the WSL half answers 200 with one instruction or 204 after ~25 s.
    $r = Invoke-PhoneInput 'GET' ('/next?wait=' + $LongPollMs) $null $LongPollTimeoutMs
  } catch {
    # WSL half down or restarting: back off and reconnect.
    Start-Sleep -Seconds $backoff
    $backoff = [Math]::Min($backoff * 2, 30)
    continue
  }
  # Wrong key: do not hammer the server; the owner has to fix the key file.
  if ($r.Status -eq 401) { Start-Sleep -Seconds 60; continue }
  # Nothing to paste this round.
  if ($r.Status -eq 204) { $backoff = 1; continue }
  # Any other unexpected status: treat like a connection error.
  if ($r.Status -ne 200) { Start-Sleep -Seconds $backoff; $backoff = [Math]::Min($backoff * 2, 30); continue }
  $backoff = 1

  # {id, text, enter}: text is already final (CRLF line breaks, "enter" word removed).
  # A body that does not parse cannot be acked either: skip it (the WSL side logs ack_missing).
  try { $item = $r.Body | ConvertFrom-Json } catch { continue }
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $result = 'pasted'
  try {
    # Re-check right before touching anything: the screen may have locked meanwhile.
    if ([PhoneInputDesk]::Blocker()) {
      $result = 'not_interactive'
    } else {
      if ($item.text.Length -gt 0) {
        # Clipboard first, then Ctrl+V into whatever window has the focus.
        Set-ClipboardText $item.text
        [System.Windows.Forms.SendKeys]::SendWait('^v')
      }
      if ($item.enter) {
        # Give the target app a moment to finish the paste, then press Enter.
        Start-Sleep -Milliseconds 150
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
      }
    }
  } catch {
    # Clipboard busy or SendKeys failed: report it, keep running.
    $result = 'error'
  }
  # Ack = receipt only (becomes the reaction on the phone); never retried into a second paste.
  $ack = @{ id = $item.id; result = $result; ms = [int]$watch.ElapsedMilliseconds } | ConvertTo-Json -Compress
  try { [void](Invoke-PhoneInput 'POST' '/ack' $ack 5000) } catch { }
}
