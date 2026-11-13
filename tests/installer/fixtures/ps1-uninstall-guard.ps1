#requires -Version 5.1
<#
  Exercise the PowerShell uninstaller's ownership guard without touching the machine.

  SEED-01 is "Setup.ps1 /S /uninstall /DIR=<any user-writable directory> recursively
  deletes it": the only guard used to be Test-Path.  This fixture dot-sources the real
  Setup.ps1 through its documented test seam ($env:AIDN_SETUP_TEST_DOTSOURCE=1, which
  returns before the GUI/silent entry points), replaces the side-effecting functions
  (processes / shortcuts / autostart) with stubs, then calls Uninstall-Target against
  purpose-built directories under -WorkDir.

  Every case is a JSON object on stdout after the AIDN_PS1_GUARD_JSON: marker:
    { name, refused, deleted, sentinelAlive, message }
  The caller (tests/installer/setup-ps1-uninstall-guard.test.js) decides which cases
  must be refused.  Nothing outside -WorkDir is created or deleted.

  Author: PT-dove
#>
param(
    [Parameter(Mandatory = $true)][string]$SetupPath,
    [Parameter(Mandatory = $true)][string]$WorkDir
)

$ErrorActionPreference = 'Stop'

$env:AIDN_SETUP_TEST_DOTSOURCE = '1'
$env:AIDN_SETUP_STARTMENU_DIR = Join-Path $WorkDir 'redirected-start-menu'
$env:AIDN_SETUP_DESKTOP_DIR = Join-Path $WorkDir 'redirected-desktop'
$env:AIDN_SETUP_DEFAULT_DIR = Join-Path $WorkDir 'redirected-default-dir'

. $SetupPath

# --- side effects stubbed out: a test must never stop processes, edit shortcuts or
# --- the registry. The guard runs before these are reached for refused cases.
function Stop-TargetProcesses { param([string]$Root) return 0 }
function Remove-Shortcuts { }
function Remove-Autostart { }

function Write-Text([string]$Path, [string]$Text) {
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Write-RealManifest([string]$Root, [string[]]$RelativePaths) {
    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add('# AegisHarness embedded runtime bundle - SHA-256 manifest')
    [void]$lines.Add('# fixture: digests computed from the files this case wrote')
    [void]$lines.Add('')
    foreach ($relative in $RelativePaths) {
        $full = Join-Path $Root $relative
        $hash = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
        [void]$lines.Add($hash + '  ' + $relative)
    }
    Write-Text (Join-Path $Root 'manifests\files.sha256') (($lines -join "`n") + "`n")
}

function New-PayloadFiles([string]$Root) {
    Write-Text (Join-Path $Root 'AIDrivenNetDefense.exe') 'MZ fixture shell'
    Write-Text (Join-Path $Root 'runtime\node\node.exe') 'fixture runtime placeholder'
    Write-Text (Join-Path $Root 'console\index.html') '<!doctype html><title>fixture</title>'
}

function New-InstallRecord([string]$Root, [hashtable]$Overrides) {
    $record = [ordered]@{
        product     = 'AIDriven NetDefense'
        version     = '0.0.1-rc.3'
        installPath = $Root
        installedAt = '2026-11-04T20:00:00+08:00'
        desktopExe  = 'AIDrivenNetDefense.exe'
        channel     = 'test'
    }
    foreach ($key in $Overrides.Keys) { $record[$key] = $Overrides[$key] }
    $json = $record | ConvertTo-Json -Depth 4
    Write-Text (Join-Path $Root 'install\install.json') ($json + "`n")
}

function New-CaseDir([string]$Name) {
    $dir = Join-Path $WorkDir $Name
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    return $dir
}

# RC5-N01: a tree only *looks* genuine until it carries the credential the installer
# issues for this canonical path. The fixture asks the shipped Setup.ps1 for it (the same
# function Install-Target calls), so this cannot drift away from the real message format.
# When the function is absent (a pre-fix copy used by the mutation test) the fixture keeps
# the old shape; the mutation assertions do not depend on this.
function Add-Ownership([string]$Root) {
    if (-not (Get-Command New-OwnershipBlock -ErrorAction SilentlyContinue)) { return }
    $record = Get-InstallJson -Root $Root
    if (-not $record) { return }
    $block = New-OwnershipBlock -Root $Root -Channel ([string]$record.channel) -Version ([string]$record.version)
    $record | Add-Member -NotePropertyName ownership -NotePropertyValue $block -Force
    Write-Text (Join-Path $Root 'install\install.json') (($record | ConvertTo-Json -Depth 4) + "`n")
}

function Invoke-Case([string]$Name, [string]$Target, [bool]$ExpectRefusal, [bool]$PlantSentinel = $true) {
    $sentinel = Join-Path $Target 'user-sentinel.txt'
    $inWorkDir = $Target.StartsWith($WorkDir, [System.StringComparison]::OrdinalIgnoreCase)
    if ($PlantSentinel -and $inWorkDir -and -not (Test-Path -LiteralPath $sentinel)) {
        Write-Text $sentinel 'this file belongs to the user and must survive a refused uninstall'
    }
    $refused = $false
    $message = ''
    try {
        Uninstall-Target -Target $Target -KeepData $false -SkipRegistry $true -OnStep $null
    } catch {
        $refused = $true
        $message = $_.Exception.Message
    }
    $deleted = -not (Test-Path -LiteralPath $Target)
    $sentinelAlive = Test-Path -LiteralPath $sentinel
    if (-not $inWorkDir) { $sentinelAlive = $true }
    [pscustomobject]@{
        name          = $Name
        expectRefusal = $ExpectRefusal
        refused       = $refused
        deleted       = $deleted
        sentinelAlive = $sentinelAlive
        message       = $message
    }
}

$results = New-Object System.Collections.ArrayList

# ---------------------------------------------------------------- forged records
# (a) two identity fields only: this is exactly re-attack bypass A.
$dir = New-CaseDir 'forged-record-two-fields'
Write-Text (Join-Path $dir 'notes\thesis.docx') 'irreplaceable user document'
New-InstallRecord $dir @{ version = '1.2.3' }
Remove-Item -LiteralPath (Join-Path $dir 'install\install.json') -Force
Write-Text (Join-Path $dir 'install\install.json') "{`n  `"product`": `"AIDriven NetDefense`",`n  `"version`": `"1.2.3`"`n}`n"
[void]$results.Add((Invoke-Case 'forged-record-two-fields' $dir $true))

# (b) product + channel only: second variant of bypass A.
$dir = New-CaseDir 'forged-record-product-channel'
Write-Text (Join-Path $dir 'notes\thesis.docx') 'irreplaceable user document'
Write-Text (Join-Path $dir 'install\install.json') "{`n  `"product`": `"AIDriven NetDefense`",`n  `"channel`": `"portable`"`n}`n"
[void]$results.Add((Invoke-Case 'forged-record-product-channel' $dir $true))

# (c) all four identity fields but no payload bytes: the record alone must not be proof.
$dir = New-CaseDir 'forged-record-all-fields'
Write-Text (Join-Path $dir 'notes\thesis.docx') 'irreplaceable user document'
New-InstallRecord $dir @{}
[void]$results.Add((Invoke-Case 'forged-record-all-fields' $dir $true))

# (d) forged bundle.json + one handwritten digest row that does not match the file.
$dir = New-CaseDir 'forged-bundle-fake-digest'
Write-Text (Join-Path $dir 'notes\thesis.docx') 'irreplaceable user document'
New-PayloadFiles $dir
Write-Text (Join-Path $dir 'bundle.json') ('{"schemaVersion":"1.0","author":"PT-dove","kind":"packaging-poc","paths":{"node":"runtime/node/node.exe"}}' + "`n")
Write-Text (Join-Path $dir 'manifests\files.sha256') (('a' * 64) + "  runtime/node/node.exe`n" + ('b' * 64) + "  AIDrivenNetDefense.exe`n" + ('c' * 64) + "  console/index.html`n")
[void]$results.Add((Invoke-Case 'forged-bundle-fake-digest' $dir $true))

# (e) same forgery wrapped in CRLF + UTF-8 BOM: a BOM is not a manifest this pipeline writes.
$dir = New-CaseDir 'forged-bundle-crlf-bom'
Write-Text (Join-Path $dir 'notes\thesis.docx') 'irreplaceable user document'
New-PayloadFiles $dir
Write-Text (Join-Path $dir 'bundle.json') ('{"schemaVersion":"1.0","author":"PT-dove","kind":"packaging-poc","paths":{"node":"runtime/node/node.exe"}}' + "`r`n")
$bomRows = ('a' * 64) + "  runtime/node/node.exe`r`n" + ('b' * 64) + "  AIDrivenNetDefense.exe`r`n" + ('c' * 64) + "  console/index.html`r`n"
New-Item -ItemType Directory -Path (Join-Path $dir 'manifests') -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $dir 'manifests\files.sha256'), $bomRows, (New-Object System.Text.UTF8Encoding($true)))
[void]$results.Add((Invoke-Case 'forged-bundle-crlf-bom' $dir $true))

# (f) manifest row escaping the tree: ../../ victim.
$dir = New-CaseDir 'forged-bundle-traversal'
Write-Text (Join-Path $dir 'notes\thesis.docx') 'irreplaceable user document'
New-PayloadFiles $dir
Write-Text (Join-Path $dir 'bundle.json') ('{"schemaVersion":"1.0","author":"PT-dove","kind":"packaging-poc","paths":{"node":"runtime/node/node.exe"}}' + "`n")
Write-Text (Join-Path $dir 'manifests\files.sha256') (('a' * 64) + "  ../../../victim.txt`n" + ('b' * 64) + "  runtime/node/node.exe`n" + ('c' * 64) + "  AIDrivenNetDefense.exe`n")
[void]$results.Add((Invoke-Case 'forged-bundle-traversal' $dir $true))

# (g) absurd absolute path in the manifest.
$dir = New-CaseDir 'forged-bundle-absurd-path'
Write-Text (Join-Path $dir 'notes\thesis.docx') 'irreplaceable user document'
New-PayloadFiles $dir
Write-Text (Join-Path $dir 'bundle.json') ('{"schemaVersion":"1.0","author":"PT-dove","kind":"packaging-poc","paths":{"node":"runtime/node/node.exe"}}' + "`n")
Write-Text (Join-Path $dir 'manifests\files.sha256') (('a' * 64) + "  C:\Windows\System32\cmd.exe`n" + ('b' * 64) + "  runtime/node/node.exe`n" + ('c' * 64) + "  AIDrivenNetDefense.exe`n")
[void]$results.Add((Invoke-Case 'forged-bundle-absurd-path' $dir $true))

# ---------------------------------------------------------------- genuine trees
# (h) a real install record + a manifest whose digests match the files on disk + the
# RC5-N01 ownership credential: accepted.
$dir = New-CaseDir 'genuine-record'
New-PayloadFiles $dir
Write-RealManifest $dir @('AIDrivenNetDefense.exe', 'runtime/node/node.exe', 'console/index.html')
New-InstallRecord $dir @{}
Add-Ownership $dir
[void]$results.Add((Invoke-Case 'genuine-record' $dir $false))

# (i) an unpacked payload tree (bundle.json + matching manifest, no record): REFUSED.
# RC5-N01 removed this branch as a delete authorization: it was half of the forgery
# surface (whoever can write the target can write bundle.json + a self-consistent
# manifest). Such a tree is still upgradable in place, or removable by hand.
$dir = New-CaseDir 'genuine-bundle'
New-PayloadFiles $dir
Write-RealManifest $dir @('AIDrivenNetDefense.exe', 'runtime/node/node.exe', 'console/index.html')
Write-Text (Join-Path $dir 'bundle.json') ('{"schemaVersion":"1.0","author":"PT-dove","kind":"packaging-poc","paths":{"node":"runtime/node/node.exe","console":"console/index.html"}}' + "`n")
[void]$results.Add((Invoke-Case 'genuine-bundle' $dir $true))

# (j) empty directory: nothing to lose, accepted (same rule as the Python uninstaller).
$dir = New-CaseDir 'empty-dir'
[void]$results.Add((Invoke-Case 'empty-dir' $dir $false $false))

# ---------------------------------------------------------------- path / link gates
# (k) a directory that does not exist is refused without side effects (both before
# and after the fix; kept so the guard's existence check has a regression).
[void]$results.Add((Invoke-Case 'missing-dir' (Join-Path $WorkDir 'no-such-install-dir') $true))

# (l) junction: recursive delete would go through the link, so it must be refused.
$realDir = New-CaseDir 'junction-real'
New-PayloadFiles $realDir
Write-RealManifest $realDir @('AIDrivenNetDefense.exe', 'runtime/node/node.exe', 'console/index.html')
New-InstallRecord $realDir @{}
Add-Ownership $realDir
$linkDir = Join-Path $WorkDir 'junction-link'
if (Test-Path -LiteralPath $linkDir) { Remove-Item -LiteralPath $linkDir -Force -Recurse }
$created = $false
try {
    New-Item -ItemType Junction -Path $linkDir -Target $realDir -ErrorAction Stop | Out-Null
    $created = $true
} catch {
    try {
        cmd /c mklink /J "$linkDir" "$realDir" | Out-Null
        $created = Test-Path -LiteralPath $linkDir
    } catch { $created = $false }
}
if ($created) {
    $junctionResult = Invoke-Case 'junction-link' $linkDir $true
    # Invoke-Case plants its sentinel through the link; the real tree must survive too.
    $junctionResult | Add-Member -NotePropertyName realTreeAlive -NotePropertyValue (Test-Path -LiteralPath $realDir)
    [void]$results.Add($junctionResult)
} else {
    [void]$results.Add([pscustomobject]@{
        name = 'junction-link'; expectRefusal = $true; refused = $true; deleted = $false
        sentinelAlive = $true; realTreeAlive = $true; message = 'junction creation unavailable; skipped (no symlink privilege)'
    })
}

$json = $results | ConvertTo-Json -Depth 5 -Compress
[Console]::Out.WriteLine('AIDN_PS1_GUARD_JSON:' + $json)
exit 0
