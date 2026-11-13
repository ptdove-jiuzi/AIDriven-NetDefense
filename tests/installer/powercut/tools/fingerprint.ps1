# Per-file sha256 fingerprint of a directory tree -> TSV (relative path, bytes, sha256), sorted.
#
# Round-5 powercut seat (POST-SHIP-PATH / powercut-r5). The same shape as
# evidence/upgrade/r4/fingerprint.ps1 (round-4), kept here so this seat's evidence is
# reproducible from a single directory and does not depend on another round's files.
#
# Author: PT-dove
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
$rows = New-Object System.Collections.Generic.List[string]
if (Test-Path -LiteralPath $Path) {
  $full = (Resolve-Path -LiteralPath $Path).Path
  Get-ChildItem -LiteralPath $full -Recurse -File -ErrorAction SilentlyContinue | Sort-Object FullName | ForEach-Object {
    $rel = $_.FullName.Substring($full.Length + 1)
    $h = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower()
    $rows.Add("$rel`t$($_.Length)`t$h")
  }
}
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$rows | Set-Content -LiteralPath $Out -Encoding UTF8
Write-Output "fingerprint $Path -> $Out  files=$($rows.Count)"
