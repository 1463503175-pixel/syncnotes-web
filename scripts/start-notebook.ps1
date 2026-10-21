param(
  [switch]$OpenBrowser
)

$ErrorActionPreference = "SilentlyContinue"

$appDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$node = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not (Test-Path -LiteralPath $node) -and $nodeCommand) {
  $node = $nodeCommand.Source
}
$server = Join-Path $appDir "server.js"
$log = Join-Path $appDir "notebook-start.log"
$outLog = Join-Path $appDir "notebook-server.out.log"
$errLog = Join-Path $appDir "notebook-server.err.log"
$url = "http://localhost:8765"
$port = 8765

function Write-NotebookLog($message) {
  try {
    Add-Content -LiteralPath $log -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $message" -Encoding UTF8
  } catch {}
}

function Test-NotebookPort {
  try {
    $client = [Net.Sockets.TcpClient]::new()
    $iar = $client.BeginConnect("127.0.0.1", $port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(250, $false)
    if ($ok) { $client.EndConnect($iar) }
    $client.Close()
    return $ok
  } catch {
    return $false
  }
}

if (-not (Test-NotebookPort)) {
  if ((Test-Path $node) -and (Test-Path $server)) {
    Write-NotebookLog "Starting server. Node=$node Server=$server AppDir=$appDir"
    Start-Process -FilePath $node -ArgumentList "`"$server`"" -WorkingDirectory $appDir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  } else {
    Write-NotebookLog "Missing file. NodeExists=$(Test-Path $node) ServerExists=$(Test-Path $server)"
  }
} else {
  Write-NotebookLog "Port $port already open."
}

if ($OpenBrowser) {
  for ($i = 0; $i -lt 30; $i++) {
    if (Test-NotebookPort) { break }
    Start-Sleep -Milliseconds 300
  }
  Start-Process $url
}
