/**
 * Silent Desktop relaunch.
 *
 * The Host cannot ask the Electron shell to restart without the shell's own
 * native confirmation dialog, and that dialog defaults to "Cancel". Instead a
 * helper closes the Electron main process gracefully (WM_CLOSE, the same path as
 * the window close button) and starts the same executable again.
 *
 * Launch chain, and why it is shaped this way:
 *   Host -> wscript.exe launch.vbs (GUI subsystem: no console) -> powershell worker
 *
 * A `detached` PowerShell spawned straight from Node exits before running the
 * script, and a plain child dies with its parent's console. `WScript.Shell.Run`
 * with a hidden window starts the worker with its own console and the Host's
 * environment, and it survives the wscript launcher exiting immediately.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { stateDir } from './state.js'

/** Absolute path to Windows PowerShell, independent of PATH. */
export function powershellPath() {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** Absolute path to the Windows Script Host (GUI subsystem, no console). */
export function wscriptPath() {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return path.join(root, 'System32', 'wscript.exe')
}

export function relaunchScriptPath() {
  return path.join(stateDir(), 'relaunch.ps1')
}

export function relaunchLauncherPath() {
  return path.join(stateDir(), 'launch.vbs')
}

export function relaunchLogPath() {
  return path.join(stateDir(), 'relaunch.log')
}

/** The helper script; kept as one literal so a packaged bundle needs no extra files. */
function helperSource() {
  return `param(
  [int]$ParentPid,
  [int]$HostPid,
  [string]$ExePath,
  [string]$LogPath
)
function Write-Log([string]$Message) {
  try { Add-Content -LiteralPath $LogPath -Value ((Get-Date).ToString('o') + ' ' + $Message) } catch {}
}
function Get-OriginalArguments([int]$TargetId, [string]$Executable) {
  try {
    $info = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetId"
    $line = $info.CommandLine
    if ([string]::IsNullOrWhiteSpace($line)) { return '' }
    if ($line.StartsWith('"')) {
      $end = $line.IndexOf('"', 1)
      if ($end -gt 0) { return $line.Substring($end + 1).Trim() }
      return ''
    }
    if ($line.StartsWith($Executable, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $line.Substring($Executable.Length).Trim()
    }
    $space = $line.IndexOf(' ')
    if ($space -gt 0) { return $line.Substring($space + 1).Trim() }
    return ''
  } catch {
    Write-Log ("command-line read failed: " + $_.Exception.Message)
    return ''
  }
}
Write-Log ("helper start parent=" + $ParentPid + " host=" + $HostPid + " exe=" + $ExePath)
# The Desktop starts its Host in Electron's Node mode, so this worker inherited
# ELECTRON_RUN_AS_NODE=1. If the relaunched app inherits it too, Electron runs as
# plain Node with no script, reads EOF on stdin, and exits before any window.
if (Test-Path Env:ELECTRON_RUN_AS_NODE) {
  Write-Log ("clearing ELECTRON_RUN_AS_NODE=" + $env:ELECTRON_RUN_AS_NODE)
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}
$appArguments = Get-OriginalArguments -TargetId $ParentPid -Executable $ExePath
Write-Log ("original arguments: [" + $appArguments + "]")
Start-Sleep -Milliseconds 900
$graceful = $false
try { $null = & taskkill.exe /PID $ParentPid 2>&1 } catch { Write-Log ("taskkill error: " + $_.Exception.Message) }
$deadline = (Get-Date).AddSeconds(4)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { $graceful = $true; break }
  Start-Sleep -Milliseconds 250
}
if (-not $graceful) {
  # close-to-tray keeps the app alive on WM_CLOSE; stop the Host first, then the
  # shell. Never use /T here: this worker may be a descendant of the Host.
  Write-Log 'graceful quit timed out; forcing'
  if ($HostPid -gt 0 -and $HostPid -ne $PID) {
    try { $null = & taskkill.exe /PID $HostPid /F 2>&1 } catch { Write-Log ("host kill error: " + $_.Exception.Message) }
    Start-Sleep -Milliseconds 400
  }
  try { $null = & taskkill.exe /PID $ParentPid /F 2>&1 } catch { Write-Log ("force kill error: " + $_.Exception.Message) }
  Start-Sleep -Seconds 2
}
Start-Sleep -Milliseconds 1200
function Find-AppProcess([string]$Path) {
  try {
    return @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $Path })
  } catch {
    return @()
  }
}
$started = $false
for ($attempt = 1; $attempt -le 2 -and -not $started; $attempt++) {
  if ((Find-AppProcess $ExePath).Count -gt 0) { $started = $true; break }
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $ExePath
    $psi.Arguments = $appArguments
    $psi.WorkingDirectory = (Split-Path -Parent $ExePath)
    $psi.UseShellExecute = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Normal
    $process = [System.Diagnostics.Process]::Start($psi)
    Write-Log ("relaunch attempt " + $attempt + " pid=" + $process.Id)
    Start-Sleep -Seconds 4
    if (-not $process.HasExited) { $started = $true }
    else {
      try { Write-Log ("attempt " + $attempt + " exited code=" + $process.ExitCode) } catch {}
      $started = (Find-AppProcess $ExePath).Count -gt 0
    }
  } catch {
    Write-Log ("relaunch attempt " + $attempt + " failed: " + $_.Exception.Message)
  }
  if (-not $started) { Start-Sleep -Seconds 2 }
}
if (-not $started) {
  # Last resort: the shell association launch, which does not inherit this
  # process's console or window state.
  Write-Log 'fallback: explorer launch'
  try { $null = & explorer.exe $ExePath } catch { Write-Log ("explorer launch failed: " + $_.Exception.Message) }
  Start-Sleep -Seconds 5
  $started = (Find-AppProcess $ExePath).Count -gt 0
  Write-Log ("fallback started=" + $started)
}
Write-Log ("done started=" + $started)
`
}

/**
 * Write the worker script to disk and return its path.
 * @returns {string} absolute script path.
 */
export function writeRelaunchScript() {
  const script = relaunchScriptPath()
  fs.mkdirSync(path.dirname(script), { recursive: true })
  fs.writeFileSync(script, helperSource(), 'utf8')
  return script
}

/**
 * Quote one command-line token so Windows/PowerShell parses it as one argument.
 * @param {string} value - raw token.
 * @returns {string} quoted token.
 */
function quote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`
}

/**
 * Write the VBS launcher that starts the worker hidden and detached.
 * @param {string} script - worker script path.
 * @param {string} log - worker log path.
 * @param {{ parentPid?: number, hostPid?: number, exePath?: string }} [overrides] - test seams.
 * @returns {string} launcher path.
 */
export function writeRelaunchLauncher(script, log, overrides = {}) {
  const parentPid = overrides.parentPid ?? process.ppid
  const hostPid = overrides.hostPid ?? process.pid
  const exePath = overrides.exePath ?? process.execPath
  const worker = [
    quote(powershellPath()),
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    quote(script),
    '-ParentPid',
    String(parentPid),
    '-HostPid',
    String(hostPid),
    '-ExePath',
    quote(exePath),
    '-LogPath',
    quote(log),
  ].join(' ')
  const vbs = [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run "${worker.replaceAll('"', '""')}", 0, False`,
    '',
  ].join('\r\n')
  const launcher = relaunchLauncherPath()
  fs.mkdirSync(path.dirname(launcher), { recursive: true })
  // Windows Script Host reads .vbs as ANSI unless a BOM marks UTF-16; the home
  // path may contain non-ASCII characters, so always write UTF-16LE + BOM.
  const body = Buffer.from(vbs, 'utf16le')
  fs.writeFileSync(launcher, Buffer.concat([Buffer.from([0xff, 0xfe]), body]))
  return launcher
}

/**
 * Start the launcher and wait for it to hand off (wscript exits immediately).
 * @param {number} timeoutMs - upper bound for the launcher itself.
 * @returns {Promise<{ ok: boolean, code: number | null, launcher: string }>} launch result.
 */
export function requestAppRelaunch(timeoutMs = 8000) {
  const script = writeRelaunchScript()
  const log = relaunchLogPath()
  const launcher = writeRelaunchLauncher(script, log)
  const child = spawn(wscriptPath(), [launcher], { stdio: 'ignore', windowsHide: true })
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: true, code: null, launcher }), timeoutMs)
    timer.unref?.()
    child.on('error', (error) => finish({ ok: false, code: null, launcher, error: error.message }))
    child.on('exit', (code) => finish({ ok: code === 0, code, launcher }))
  })
}

/** @returns {boolean} whether this Host can relaunch the Desktop silently. */
export function canRelaunchSilently() {
  if (process.platform !== 'win32') return false
  if (!Number.isInteger(process.ppid) || process.ppid <= 0) return false
  try {
    return fs.existsSync(process.execPath) && fs.existsSync(wscriptPath())
  } catch {
    return false
  }
}
