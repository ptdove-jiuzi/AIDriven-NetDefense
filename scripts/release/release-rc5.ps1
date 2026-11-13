#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Publish AIDriven NetDefense rc.5 to GitHub in the only order that keeps the
    updater working. Dry-run by default; nothing is written without -Execute.

.DESCRIPTION
    The update client asks ONE url: releases/latest/download/latest.json
    (apps/desktop/updater/constants.py). That single fact fixes the order:

      1. tag v0.0.1-rc.5 (on the source-true commit)
      2. release (draft=true, prerelease=true)  <- draft is invisible to /latest
      3. upload Setup.exe
      4. upload portable.zip
      5. upload latest.json   <- LAST: it is the file that makes the release "live"
      6. optional -Publish: draft -> public. Off by default; a human clicks this.

    Anything uploaded after latest.json, or a release made public before latest.json
    exists, leaves the updater with a manifest pointing at missing assets, or a 404.

    Exit codes:
      0  assets + order + source snapshot all ready -> safe to publish
      10 assets/order ready but the source snapshot is BLOCKING (or tag/target
         unresolvable): do STEP 0 first. -AllowStaleSource downgrades the P6
         mismatch only, with an explicit "binaries are not traceable" warning.
      1  hard failure: P1-P4/P7 red, or verify-release.mjs non-zero.

.PARAMETER Execute
    Actually perform the network writes. Requires -ConfirmRelease <tag> and a
    non-empty $env:GITHUB_TOKEN. The token is never printed, only its length.

.PARAMETER DryRun
    Explicit dry-run (same as omitting -Execute). Exists so CI can say it plainly.

.PARAMETER ConfirmRelease
    Must equal the tag exactly, e.g. 'v0.0.1-rc.5'. A second, deliberate keystroke.

.PARAMETER AssetsDir
    Release directory holding the five artifacts. Default dist/release/0.0.1-rc.5.

.PARAMETER TagTarget
    Commit sha the tag must point at. Default: refs/heads/main on origin.

.PARAMETER AllowStaleSource
    Bypass P6 (export snapshot lags current source) and print a loud warning.

.PARAMETER Publish
    Step 6: PATCH the draft release to draft=false. Never runs in dry-run.

.PARAMETER TagExists
    Inject "tag already exists" without touching the network (negative test hook).

.PARAMETER EvidenceOut
    Write preflight-result.json here (the evidence directory).

.EXAMPLE
    pwsh -NoProfile -File scripts/release/release-rc5.ps1 -DryRun

.EXAMPLE
    pwsh -NoProfile -File scripts/release/release-rc5.ps1 -DryRun -AllowStaleSource

Author: PT-dove
#>
[CmdletBinding()]
param(
    [switch]$Execute,
    [switch]$DryRun,
    [string]$ConfirmRelease = '',
    [string]$AssetsDir = 'dist/release/0.0.1-rc.5',
    [string]$Repo = 'ptdove-jiuzi/AIDriven-NetDefense',
    [string]$Version = '0.0.1-rc.5',
    [string]$Tag = 'v0.0.1-rc.5',
    [string]$WorkTree = '.publish/AIDriven-NetDefense',
    [string]$TagTarget = '',
    [switch]$AllowStaleSource,
    [switch]$Publish,
    [switch]$TagExists,
    [string]$EvidenceOut = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Files whose bytes must already be in the export snapshot before we tag it.
$SourceFiles = @(
    'apps/daemon/src/scheduler.js',
    'apps/daemon/src/health.js',
    'apps/daemon/src/adapters/collector-sources.js',
    'deploy/windows/installer/app/aidn/install.py'
)
$ApiBase = "https://api.github.com/repos/$Repo"
$UploadBase = "https://uploads.github.com/repos/$Repo"
$Headers = @(
    'Accept: application/vnd.github+json'
    'X-GitHub-Api-Version: 2022-11-28'
    'User-Agent: AIDriven-NetDefense-release-rc5'
)
$StepNames = @('tag', 'release(draft)', 'upload Setup.exe', 'upload portable.zip', 'upload latest.json', 'publish')
$Checks = [System.Collections.Generic.List[object]]::new()
$Done = [System.Collections.Generic.List[string]]::new()
$Script:CurrentStep = 0
$TokenLen = if ([string]::IsNullOrEmpty($env:GITHUB_TOKEN)) { 0 } else { $env:GITHUB_TOKEN.Length }

function Log { param([string]$Text = '') Write-Output $Text }
function Head {
    param([string]$Text)
    Log ''
    Log ('=' * 78)
    Log $Text
    Log ('=' * 78)
}
function Check {
    param([string]$Id, [string]$Area, [string]$Status, [string]$Detail)
    $Checks.Add([pscustomobject]@{ id = $Id; area = $Area; status = $Status; detail = $Detail })
    $lbl = switch ($Status) { 'OK' { '[ OK ]' } 'FAIL' { '[FAIL]' } 'BLOCKING' { '[BLOCK]' } default { '[WARN]' } }
    Log ("{0} {1,-3} {2} :: {3}" -f $lbl, $Id, $Area, $Detail)
}
function GitOut {
    param([string[]]$GitArgs)
    $raw = & git @GitArgs 2>&1
    $code = $LASTEXITCODE
    $lines = @($raw | ForEach-Object { "$_" })
    [pscustomobject]@{ Exit = $code; Text = ($lines -join "`n"); Lines = $lines }
}
function New-TempFile {
    param([string]$Ext = 'json')
    Join-Path ([IO.Path]::GetTempPath()) ("rc5-{0}.{1}" -f [guid]::NewGuid().ToString('N'), $Ext)
}
function Esc([string]$s) { [uri]::EscapeDataString($s) }

# ---------------------------------------------------------------- mode gate
$ScriptDir = $PSScriptRoot
$Root = (Resolve-Path (Join-Path $ScriptDir '..\..')).Path
$DirAbs = if ([IO.Path]::IsPathRooted($AssetsDir)) { $AssetsDir } else { Join-Path $Root $AssetsDir }
$TreeAbs = if ([IO.Path]::IsPathRooted($WorkTree)) { $WorkTree } else { Join-Path $Root $WorkTree }

$Mode = 'DRY-RUN'
if ($Execute) {
    if ($DryRun) {
        Log 'FATAL: -Execute and -DryRun are mutually exclusive.'
        exit 1
    }
    if ($ConfirmRelease -ne $Tag) {
        Log "FATAL: -Execute requires -ConfirmRelease '$Tag' (got '$ConfirmRelease'). Nothing was written."
        exit 1
    }
    if ($TokenLen -eq 0) {
        Log 'FATAL: -Execute requires a non-empty $env:GITHUB_TOKEN. Nothing was written.'
        Log '       (dry-run needs no token: that is what makes it safe to rehearse.)'
        exit 1
    }
    $Mode = 'EXECUTE'
}

Head "AIDriven NetDefense rc.5 release :: mode=$Mode version=$Version tag=$Tag"
Log "repo        : $Repo"
Log "assets dir  : $DirAbs"
Log "work tree   : $TreeAbs"
Log "token       : $(if ($TokenLen -gt 0) { "present, length=$TokenLen (value never printed)" } else { 'absent (dry-run only)' })"
Log "flags       : AllowStaleSource=$AllowStaleSource Publish=$Publish TagExistsStub=$TagExists"
Log "preflight runs in dry-run too: it is read-only and it is the whole point."

$CurlExe = $null
foreach ($c in @('curl.exe', 'curl')) {
    $p = Get-Command $c -ErrorAction SilentlyContinue
    if ($p) { $CurlExe = $p.Source; break }
}
Log "curl        : $(if ($CurlExe) { $CurlExe } else { 'MISSING' })"

# ---------------------------------------------------------------- preflight
Head 'PREFLIGHT (read-only; runs identically in dry-run and execute)'

# P0 - the export work tree must be a usable git repo.
$p0 = GitOut @('-C', $TreeAbs, 'rev-parse', '--git-dir')
if ($p0.Exit -ne 0) {
    Check 'P0' 'export work tree' 'FAIL' "not a git repo: $TreeAbs :: $($p0.Text)"
} else {
    # "git -C <dir>" also resolves an ANCESTOR repo, so a wrong -WorkTree (e.g. a directory
    # under C:\Users\<name>, which is itself a git repo on this host) would keep P0 green
    # while P5/P6/P7 silently inspect the wrong tree.  Require the repo root to BE the tree.
    $headSha = (GitOut @('-C', $TreeAbs, 'rev-parse', 'HEAD')).Text.Trim()
    $p0root = (GitOut @('-C', $TreeAbs, 'rev-parse', '--show-toplevel')).Text.Trim()
    $wantRoot = [IO.Path]::GetFullPath($TreeAbs).TrimEnd('\', '/')
    $gotRoot = if ($p0root) { [IO.Path]::GetFullPath($p0root).TrimEnd('\', '/') } else { '' }
    if ($gotRoot -ne $wantRoot) {
        Check 'P0' 'export work tree' 'FAIL' "git resolved an ANCESTOR repo (root='$gotRoot') instead of the work tree ('$wantRoot'); P5/P6/P7 would inspect the wrong tree"
    } else {
        Check 'P0' 'export work tree' 'OK' "git ok, root=$gotRoot HEAD=$headSha"
    }
}

# P1 - all five artifacts present and non-empty.
$Expected = @(
    @{ Name = 'AIDrivenNetDefense-Setup-0.0.1-rc.5.exe'; Min = 1000000 }
    @{ Name = 'AIDrivenNetDefense-0.0.1-rc.5-win-x64-portable.zip'; Min = 1000000 }
    @{ Name = 'latest.json'; Min = 100 }
    @{ Name = 'RELEASE-NOTES.md'; Min = 100 }
    @{ Name = 'SHA256SUMS.txt'; Min = 10 }
)
$missing = @()
foreach ($e in $Expected) {
    $p = Join-Path $DirAbs $e.Name
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { $missing += "$($e.Name) (absent)"; continue }
    $len = (Get-Item -LiteralPath $p).Length
    if ($len -lt $e.Min) { $missing += "$($e.Name) ($len B < $($e.Min))" }
}
if ($missing.Count -gt 0) { Check 'P1' 'five artifacts' 'FAIL' ($missing -join '; ') }
else { Check 'P1' 'five artifacts' 'OK' '5/5 present, all non-empty' }

# P2 - size + sha256 must agree three ways: disk / SHA256SUMS.txt / latest.json.
$Disk = @{}
foreach ($e in @($Expected[0], $Expected[1])) {
    $p = Join-Path $DirAbs $e.Name
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { continue }
    $Disk[$e.Name] = [pscustomobject]@{
        Name   = $e.Name
        Size   = (Get-Item -LiteralPath $p).Length
        Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant()
    }
}
$Sums = @{}
$sumsPath = Join-Path $DirAbs 'SHA256SUMS.txt'
if (Test-Path -LiteralPath $sumsPath) {
    foreach ($line in (Get-Content -LiteralPath $sumsPath)) {
        if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') {
            $Sums[$Matches[2]] = $Matches[1].ToLowerInvariant()
        }
    }
}
$Manifest = $null
$manifestPath = Join-Path $DirAbs 'latest.json'
if (Test-Path -LiteralPath $manifestPath) {
    try { $Manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json }
    catch { $Manifest = $null }
}
$p2bad = @()
foreach ($k in $Disk.Keys) {
    $d = $Disk[$k]
    $s = $Sums[$k]
    $m = @($Manifest.assets | Where-Object { $_.name -eq $k }) | Select-Object -First 1
    if (-not $s) { $p2bad += "$k not listed in SHA256SUMS.txt" }
    elseif ($s -ne $d.Sha256) { $p2bad += "$k SHA256SUMS=$($s.Substring(0,12)).. != disk=$($d.Sha256.Substring(0,12)).." }
    if (-not $m) { $p2bad += "$k not listed in latest.json.assets" }
    else {
        if ($m.sha256 -ne $d.Sha256) { $p2bad += "$k latest.json sha256 != disk" }
        if ([int64]$m.size -ne [int64]$d.Size) { $p2bad += "$k latest.json size=$($m.size) != disk=$($d.Size)" }
    }
}
if ($Disk.Count -ne 2) { $p2bad += "expected 2 packages on disk, found $($Disk.Count)" }
if ($p2bad.Count -gt 0) { Check 'P2' 'size+sha256 3-way' 'FAIL' ($p2bad -join '; ') }
else {
    foreach ($d in $Disk.Values) {
        Log ("       {0} :: {1} B :: {2}" -f $d.Name, $d.Size, $d.Sha256)
    }
    Check 'P2' 'size+sha256 3-way' 'OK' 'disk == SHA256SUMS.txt == latest.json for both packages'
}

# P3 - the independent verifier must pass. Re-derive, never trust finalize.
$verify = Join-Path $Root 'scripts\release\verify-release.mjs'
$p3ok = $false
if (-not (Test-Path -LiteralPath $verify)) {
    Check 'P3' 'verify-release.mjs' 'FAIL' "missing: $verify"
} else {
    $node = (Get-Command node -ErrorAction SilentlyContinue)
    if (-not $node) { Check 'P3' 'verify-release.mjs' 'FAIL' 'node not on PATH' }
    else {
        Push-Location $Root
        try {
            $vout = & node $verify --dir $AssetsDir --version $Version --repo $Repo --tag $Tag 2>&1
            $vcode = $LASTEXITCODE
        } finally { Pop-Location }
        $vlines = @($vout | ForEach-Object { "$_" })
        $vtail = ($vlines | Select-Object -Last 4) -join ' | '
        if ($vcode -eq 0) {
            $okCount = @($vlines | Where-Object { $_ -match '^\s*(ok|OK)\b|\bok\b' }).Count
            Check 'P3' 'verify-release.mjs' 'OK' "exit=0 lines=$($vlines.Count) :: $vtail"
            $p3ok = $true
        } else {
            Check 'P3' 'verify-release.mjs' 'FAIL' "exit=$vcode :: $vtail"
        }
    }
}

# P4 - manifest URLs must point at this repo spelling and this tag.
$p4bad = @()
if (-not $Manifest) { $p4bad += 'latest.json unreadable' }
else {
    if ($Manifest.version -ne $Version) { $p4bad += "version '$($Manifest.version)' != '$Version'" }
    foreach ($a in @($Manifest.assets)) {
        if ($a.url -notmatch '^https://github\.com/(?<owner>[^/]+)/(?<repo>[^/]+)/releases/download/(?<tag>[^/]+)/(?<asset>.+)$') {
            $p4bad += "$($a.name): url shape unrecognised ($($a.url))"
            continue
        }
        if ($Matches['tag'] -ne $Tag) { $p4bad += "$($a.name): url tag '$($Matches['tag'])' != '$Tag'" }
        if ($Matches['repo'] -cne 'AIDriven-NetDefense') { $p4bad += "$($a.name): repo '$($Matches['repo'])' is not 'AIDriven-NetDefense' (case-sensitive)" }
        if ($Matches['owner'] -cne 'ptdove-jiuzi') { $p4bad += "$($a.name): owner '$($Matches['owner'])' != 'ptdove-jiuzi'" }
        if ($Matches['asset'] -ne $a.name) { $p4bad += "$($a.name): url ends with '$($Matches['asset'])'" }
    }
    if (@($Manifest.assets).Count -ne 2) { $p4bad += "latest.json.assets count $(@($Manifest.assets).Count) != 2" }
}
if ($p4bad.Count -gt 0) { Check 'P4' 'manifest urls' 'FAIL' ($p4bad -join '; ') }
else { Check 'P4' 'manifest urls' 'OK' "both urls: tag=$Tag repo=AIDriven-NetDefense owner=ptdove-jiuzi, name matches" }

# P5 - does the tag already exist? Read-only; unreachable network is BLOCKING, not "fine".
$TagExistsReal = $false
$p5 = GitOut @('-C', $TreeAbs, 'ls-remote', '--tags', 'origin', $Tag)
if ($p5.Exit -ne 0) {
    Check 'P5' 'tag absent' 'BLOCKING' "UNVERIFIED - git ls-remote failed (exit=$($p5.Exit)): $($p5.Text.Trim())"
} elseif ($TagExists -or $env:RELEASE_RC5_STUB_TAG_EXISTS -eq '1') {
    Check 'P5' 'tag absent' 'BLOCKING' "tag $Tag already exists (injected stub, no network used)"
} elseif (($p5.Lines | Where-Object { $_ -match "refs/tags/$([regex]::Escape($Tag))\s*$" }).Count -gt 0) {
    Check 'P5' 'tag absent' 'BLOCKING' "tag $Tag already exists on origin: $($p5.Text.Trim())"
} else {
    Check 'P5' 'tag absent' 'OK' "origin has no tag $Tag (ls-remote --tags returned nothing)"
}

# P6 - do the bytes in the export snapshot match the current source? git blob hashes,
#      so no binary ever passes through the PowerShell pipeline.
$Target = $TagTarget
if ([string]::IsNullOrWhiteSpace($Target)) {
    $main = GitOut @('-C', $TreeAbs, 'ls-remote', 'origin', 'refs/heads/main')
    if ($main.Exit -ne 0 -or $main.Text -notmatch '^([0-9a-f]{40})\s+refs/heads/main') {
        Check 'P6' 'source snapshot' 'BLOCKING' "UNVERIFIED - cannot resolve refs/heads/main on origin: $($main.Text.Trim())"
        $Target = $null
    } else { $Target = $Matches[1] }
}
if ($Target -and $Target -notmatch '^[0-9a-f]{40}$') {
    Check 'P6' 'source snapshot' 'FAIL' "-TagTarget '$Target' is not a 40-char sha"
    $Target = $null
}
$syncRows = @()
if ($Target) {
    Log "       tag target : $Target"
    $syncBad = @()
    foreach ($rel in $SourceFiles) {
        $absFile = Join-Path $Root ($rel -replace '/', '\')
        $row = [pscustomobject]@{ path = $rel; source_blob = ''; target_blob = ''; verdict = '' }
        if (-not (Test-Path -LiteralPath $absFile -PathType Leaf)) {
            $row.verdict = 'SOURCE-MISSING'; $syncBad += "$rel (source file absent)"
        } else {
            $h = GitOut @('-C', $TreeAbs, 'hash-object', $absFile)
            $row.source_blob = $h.Text.Trim()
            if ($h.Exit -ne 0) { $row.verdict = 'HASH-FAILED'; $syncBad += "$rel (hash-object failed)" }
            else {
                $t = GitOut @('-C', $TreeAbs, 'rev-parse', "${Target}:$rel")
                if ($t.Exit -ne 0) {
                    $row.target_blob = ''; $row.verdict = 'MISSING-IN-EXPORT'
                    $syncBad += "$rel (not in $Target)"
                } else {
                    $row.target_blob = $t.Text.Trim()
                    if ($row.target_blob -eq $row.source_blob) { $row.verdict = 'MATCH' }
                    else { $row.verdict = 'BEHIND'; $syncBad += "$rel (source=$($row.source_blob.Substring(0,12)).. export=$($row.target_blob.Substring(0,12))..)" }
                }
            }
        }
        $syncRows += $row
        Log ("       {0,-52} {1,18} src={2} exp={3}" -f $rel, $row.verdict, $row.source_blob, $(if ($row.target_blob) { $row.target_blob } else { '-' }))
    }
    if ($syncBad.Count -eq 0) {
        Check 'P6' 'source snapshot' 'OK' "4/4 source files byte-identical to $Target"
    } elseif ($AllowStaleSource) {
        Check 'P6' 'source snapshot' 'WARN' ("-AllowStaleSource override: snapshot is BEHIND -> " + ($syncBad -join '; '))
    } else {
        Check 'P6' 'source snapshot' 'BLOCKING' ("snapshot behind current source: " + ($syncBad -join '; '))
    }
}

# P7 - the export work tree must be clean, otherwise the tree we tag is not the tree we compared.
$st = GitOut @('-C', $TreeAbs, 'status', '--porcelain')
$dirty = @($st.Lines | Where-Object { $_ -and $_.Trim() })
if ($st.Exit -ne 0) { Check 'P7' 'work tree clean' 'FAIL' "git status failed: $($st.Text.Trim())" }
elseif ($dirty.Count -gt 0) { Check 'P7' 'work tree clean' 'FAIL' ("uncommitted changes: " + (($dirty | Select-Object -First 8) -join ' | ')) }
else { Check 'P7' 'work tree clean' 'OK' 'git status --porcelain is empty' }

<#
    Plan printing and execution share the same step numbers, so a failure can always
    answer "what is done, what is not, and where can I safely restart".
#>
function Show-Step {
    param([int]$N, [string]$Title, [string]$Cmd, [string]$Expect)
    Log ''
    Log ("STEP {0}/{1} :: {2}" -f $N, ($StepNames.Count), $Title)
    Log "  will run : $Cmd"
    Log "  expect   : $Expect"
}
$setup = @($Manifest.assets | Where-Object { $_.name -like '*Setup*.exe' })[0]
$porta = @($Manifest.assets | Where-Object { $_.name -like '*.zip' })[0]
if (-not $setup -or -not $porta) {
    Check 'P2' 'asset roles' 'FAIL' 'latest.json must name exactly one Setup.exe and one .zip'
}
$setupName = if ($setup) { $setup.name } else { 'AIDrivenNetDefense-Setup-0.0.1-rc.5.exe' }
$portaName = if ($porta) { $porta.name } else { 'AIDrivenNetDefense-0.0.1-rc.5-win-x64-portable.zip' }
$setupSize = if ($setup) { [int64]$setup.size } else { 0 }
$portaSize = if ($porta) { [int64]$porta.size } else { 0 }
$latestSize = if (Test-Path -LiteralPath (Join-Path $DirAbs 'latest.json')) { (Get-Item -LiteralPath (Join-Path $DirAbs 'latest.json')).Length } else { 0 }
$resetSize = if (Test-Path -LiteralPath (Join-Path $DirAbs 'RELEASE-NOTES.md')) { (Get-Item -LiteralPath (Join-Path $DirAbs 'RELEASE-NOTES.md')).Length } else { 0 }
# Download-page preamble (scripts/release/RELEASE-PAGE-COPY.md).  It is composed AHEAD of
# RELEASE-NOTES.md in the Release body because it is the only surface a first-time user
# reads before clicking anything.  It changes no artifact byte and no latest.json field.
$pageCopyPath = Join-Path $PSScriptRoot 'RELEASE-PAGE-COPY.md'
$pageCopySize = if (Test-Path -LiteralPath $pageCopyPath) { (Get-Item -LiteralPath $pageCopyPath).Length } else { 0 }
$TargetText = if ($Target) { $Target } else { '<unresolved: fix P6 first>' }
# ------------------------------------------------------------------- STEP 0
# ALWAYS printed (dry-run and execute), BEFORE STEP 1: if the export snapshot does not
# carry the current source bytes, that is the one thing a human has to fix by hand.  It is
# unconditional because the remedy used to live only in the exit-10 tail, so an
# -AllowStaleSource run (exit 0) never showed the four-row gap at all.
function Show-Step0 {
    Log ''
    Log ("STEP 0/{0} :: source snapshot (human decides)" -f $StepNames.Count)
    Log '  rule      : the tag must point at the commit that actually produced these binaries;'
    Log '              this script never edits, commits or pushes the export tree.'
    Log "  tag target: $TargetText"
    Log ''
    Log '  four files that must be byte-identical (git blob equality; not a re-encoded sha256):'
    Log ("    {0,-3} {1,-52} {2,-19} {3}" -f '#', 'path', 'verdict', 'source-blob -> export-blob')
    $rows = @($syncRows)
    if ($rows.Count -eq 0) {
        $rows = @($SourceFiles | ForEach-Object {
                [pscustomobject]@{ path = $_; source_blob = ''; target_blob = ''; verdict = 'UNRESOLVED' }
            })
    }
    $n = 0
    foreach ($row in $rows) {
        $n++
        $src = if ($row.source_blob) { $row.source_blob.Substring(0, [Math]::Min(12, $row.source_blob.Length)) + '..' } else { '-' }
        $exp = if ($row.target_blob) { $row.target_blob.Substring(0, [Math]::Min(12, $row.target_blob.Length)) + '..' } else { '(absent)' }
        Log ("    {0,-3} {1,-52} {2,-19} {3}" -f "$n.", $row.path, $row.verdict, "$src -> $exp")
    }
    $notMatch = @($rows | Where-Object { $_.verdict -ne 'MATCH' })
    Log ''
    Log '  verdict   : MATCH = already in the tag target; BEHIND = tag target holds an older blob;'
    Log '              MISSING-IN-EXPORT = path absent from the tag target;'
    Log '              SOURCE-MISSING / HASH-FAILED / UNRESOLVED = local or host problem, fix first.'
    if ($notMatch.Count -eq 0) {
        Log ("  NOW       : {0}/{0} MATCH -> STEP 0 is done; STEP 1..6 below are publishable." -f $rows.Count)
    } else {
        Log ("  NOW       : {0} of {1} files are NOT in the tag target -> STEP 1..6 MUST NOT run yet." -f $notMatch.Count, $rows.Count)
        Log '              a tag on this tree makes the shipped .exe/.zip untraceable to source.'
    }
    Log ''
    Log '  human remedy, in this order (three commands; a human runs them, never this script):'
    Log '    1) re-export the whitelist into the export tree so the four files land byte-identical'
    Log '       (docs/implementation/UPLOAD-RULES.md section 2/7; never "git add -A")'
    Log '    2) run the three scans of UPLOAD-RULES.md section 4 (local paths / AI traces / credentials);'
    Log '       any hit = STOP, do not push'
    Log "    3) git -C `"$TreeAbs`" add --dry-run    (inspect, then add only whitelisted paths)"
    Log "       git -C `"$TreeAbs`" -c user.name=PT-dove -c user.email=ptdove-jiuzi@users.noreply.github.com commit -m 'sync rc.5 source'"
    Log "       git -C `"$TreeAbs`" push origin main"
    Log "       then re-run: pwsh -NoProfile -File scripts/release/release-rc5.ps1 -DryRun   (expect exit 0)"
}
Show-Step0

$OrderProof = @(
    'ORDER-PROOF (asserted at runtime by STEP 5 verification GET):'
    ("  upload order  : 1) {0}  2) {1}  3) latest.json   <- latest.json is LAST" -f 'Setup.exe', 'portable.zip')
    '  runtime claim : GET /releases/<id> -> assets.length == 3'
    '                  assets[2].name == ''latest.json'' and assets[2].id > assets[1].id'
    '                  assets[0].name == Setup.exe, assets[1].name == portable.zip'
    '  why it matters: the updater reads exactly one URL,'
    '                  https://github.com/ptdove-jiuzi/AIDriven-NetDefense/releases/latest/download/latest.json'
    '                  (apps/desktop/updater/constants.py:30-31)'
    '  if latest.json goes first : manifest is live while the packages are still uploading'
    '                             -> download URLs 404 -> every update check fails'
    '  if latest.json never lands: releases/latest/download/latest.json is 404'
    '                             -> updater errors on every check (that is the state today)'
    '  if -Publish lands before 1-5: same 404 but on a public, advertised release'
)

$uploadOrderOk = $false

# The upload order is derived ONCE here; the printed plan (STEP 3/4/5) and the P8 assertion
# both read this array, so the order claim is falsifiable instead of a hardcoded $true.
$PlanOrder = @(
    [pscustomobject]@{ Step = 3; Title = 'upload Setup.exe'; Name = $setupName; Size = $setupSize }
    [pscustomobject]@{ Step = 4; Title = 'upload portable.zip'; Name = $portaName; Size = $portaSize }
    [pscustomobject]@{ Step = 5; Title = 'upload latest.json (LAST)'; Name = 'latest.json'; Size = $latestSize }
)
if ($Mode -eq 'DRY-RUN') {
    Head 'PLANNED RELEASE (dry-run: nothing below is executed)'
    $authHint = "Authorization: Bearer <redacted; token length=$TokenLen>"
    $tagBody = (@{ ref = "refs/tags/$Tag"; sha = $TargetText } | ConvertTo-Json -Compress)
    $relBody = "{`"tag_name`":`"$Tag`",`"target_commitish`":`"$TargetText`",`"name`":`"AIDriven NetDefense $Version`",`"body`":`"<RELEASE-PAGE-COPY.md, $pageCopySize B> + <RELEASE-NOTES.md, $resetSize B>`",`"draft`":true,`"prerelease`":true}"
    Show-Step 1 'create tag' "curl.exe -sS -X POST $ApiBase/git/refs -H `"$authHint`" -H `"Accept: application/vnd.github+json`" -d '$tagBody'" "201 Created; body.ref == 'refs/tags/$Tag'; body.object.sha == '$TargetText'"
    Show-Step 2 'create draft release' "curl.exe -sS -X POST $ApiBase/releases -H `"$authHint`" -d @release-body.json  ($relBody)" "201 Created; body.id (int) + body.draft==true + body.prerelease==true + body.upload_url contains '/releases/<id>/assets{?name,label}'; tag_name=='$Tag'"
    foreach ($po in $PlanOrder) {
        $expect = "201 Created; body.name=='$($po.Name)'; body.size==$($po.Size); body.state=='uploaded'"
        if ($po.Name -eq 'latest.json') { $expect += '; then GET /releases/<id> -> 200 + assets.length==3 + ORDER-PROOF below' }
        Show-Step $po.Step $po.Title "curl.exe -sS -X POST $UploadBase/releases/<id>/assets?name=$(Esc $po.Name) -H `"$authHint`" -H 'Content-Type: application/octet-stream' --data-binary `"@$DirAbs\$($po.Name)`"" $expect
    }
    if ($Publish) {
        Show-Step 6 'publish (draft -> public)' "curl.exe -sS -X PATCH $ApiBase/releases/<id> -H `"$authHint`" -d '{`"draft`":false}'" '200 OK; body.draft==false; then GET releases/latest/download/latest.json -> 200'
    } else {
        Show-Step 6 'publish (skipped)' '-Publish not given: the release stays a draft. A human clicks the switch.' 'nothing happens; the release is invisible to /latest and to the updater'
    }
    Head 'ORDER-PROOF'
    foreach ($l in $OrderProof) { Log $l }
    $planLastOk = ($PlanOrder.Count -eq 3 -and
        $PlanOrder[0].Name -eq $setupName -and
        $PlanOrder[1].Name -eq $portaName -and
        $PlanOrder[2].Name -eq 'latest.json')
    if ($planLastOk) {
        Check 'P8' 'upload order (plan)' 'OK' "plan: 3)$($PlanOrder[0].Name) 4)$($PlanOrder[1].Name) 5)$($PlanOrder[2].Name)  <- latest.json is 5 and last"
    } else {
        Check 'P8' 'upload order (plan)' 'FAIL' ("plan is 3)$($PlanOrder[0].Name) 4)$($PlanOrder[1].Name) 5)$($PlanOrder[2].Name); expected 3)$setupName 4)$portaName 5)latest.json (LAST)")
    }
    Log ''
    Log "plan assertion: last planned upload is '$($PlanOrder[2].Name)'  ->  $planLastOk"
    Log 'dry-run performed ZERO network writes: no GitHub call is reachable from this branch.'
    Log '  code proof : Invoke-Api is DEFINED inside the -Execute branch only (search'
    Log '               "function Invoke-Api"), so the dry-run branch has no such function to call.'
    Log '               The only network call in dry-run is "git ls-remote" (read-only, no token,'
    Log '               no POST/PATCH; uploads.github.com is never contacted).'
} else {
    # ------------------------------------------------------------ execute
    Head 'EXECUTE (real network writes; stop at the first failure)'
    Head 'ORDER-PROOF (will be asserted after STEP 5)'
    foreach ($l in $OrderProof) { Log $l }
    Log ''

    if (-not $CurlExe) { Log 'FATAL: curl.exe not found; REST transport unavailable.'; exit 1 }
    $blocking = @($Checks | Where-Object { $_.status -in @('FAIL', 'BLOCKING') })
    if ($blocking.Count -gt 0) {
        Log 'ABORT before any write: preflight has FAIL/BLOCKING items:'
        foreach ($b in $blocking) { Log "  - $($b.id) $($b.area): $($b.detail)" }
        $abortCode = if (@($Checks | Where-Object { $_.status -eq 'FAIL' }).Count -gt 0) { 1 } else { 10 }
        exit $abortCode
    }

    function Invoke-Api {
        param([string]$Method, [string]$Url, [string]$BodyFile = '')
        $outFile = New-TempFile 'json'
        $cargs = @('-sS', '-X', $Method, '-o', $outFile, '-w', '%{http_code}',
            '-H', "Authorization: Bearer $($env:GITHUB_TOKEN)") + $Headers
        if ($BodyFile) { $cargs += @('-H', 'Content-Type: application/json', '--data-binary', "@$BodyFile") }
        $cargs += $Url
        $codeText = (& $CurlExe @cargs 2>$null) | Select-Object -Last 1
        $code = 0
        [void][int]::TryParse(("$codeText").Trim(), [ref]$code)
        $raw = if (Test-Path $outFile) { Get-Content -LiteralPath $outFile -Raw -Encoding utf8 } else { '' }
        $obj = $null
        if ($raw) { try { $obj = $raw | ConvertFrom-Json } catch { $obj = $null } }
        [pscustomobject]@{ Code = $code; Raw = $raw; Body = $obj }
    }
    function Need {
        param([bool]$Cond, [string]$Msg)
        if (-not $Cond) { throw "assertion failed: $Msg" }
    }
    function Fail-Step {
        param([string]$Detail)
        Log ''
        Log "FATAL: STEP $($Script:CurrentStep) ($($StepNames[$Script:CurrentStep - 1])) failed :: $Detail"
        $doneText = if ($Done.Count) { ($Done | ForEach-Object { "STEP $_ ($($StepNames[$_ - 1]))" }) -join ', ' } else { '(none)' }
        $left = (($Script:CurrentStep)..$StepNames.Count) | Where-Object { $_ -le $StepNames.Count -and (@($Done) -notcontains $_) } | ForEach-Object { "STEP $_ ($($StepNames[$_ - 1]))" }
        Log "completed      : $doneText"
        Log "not completed  : $($left -join ', ')"
        Log "re-entrant pt  : STEP $($Script:CurrentStep) - nothing before it will be repeated by this script."
        Log "                 partial GitHub state is intentional: fix the cause, then re-run by hand from STEP $($Script:CurrentStep);"
        Log "                 re-running STEP 1/2 verbatim will 422 'already exists', which is the guard, not a bug."
        exit 1
    }

    try {
        # STEP 1 - tag
        $Script:CurrentStep = 1
        Log ''
        Log "STEP 1/6 :: create tag $Tag -> $Target"
        $bodyFile = New-TempFile 'json'
        (@{ ref = "refs/tags/$Tag"; sha = "$Target" } | ConvertTo-Json -Compress) | Set-Content -LiteralPath $bodyFile -Encoding utf8NoBOM
        $r = Invoke-Api -Method POST -Url "$ApiBase/git/refs" -BodyFile $bodyFile
        Log "  http=$($r.Code)"
        Need ($r.Code -eq 201) "expected 201, got $($r.Code) :: $($r.Raw)"
        Need ($r.Body.ref -eq "refs/tags/$Tag") "body.ref '$($r.Body.ref)' != 'refs/tags/$Tag'"
        Need ($r.Body.object.sha -eq $Target) "tag points at $($r.Body.object.sha), expected $Target"
        $Done.Add(1) | Out-Null
        Log "  ok: tag created at $Target"

        # STEP 2 - draft release
        $Script:CurrentStep = 2
        Log ''
        Log 'STEP 2/6 :: create draft release (draft=true, prerelease=true)'
        $notes = Get-Content -LiteralPath (Join-Path $DirAbs 'RELEASE-NOTES.md') -Raw -Encoding utf8
        $bodyText = $notes
        if (Test-Path -LiteralPath $pageCopyPath) {
            $pageCopy = Get-Content -LiteralPath $pageCopyPath -Raw -Encoding utf8
            $bodyText = $pageCopy.TrimEnd() + "`n`n---`n`n" + $notes
            Log "  body = RELEASE-PAGE-COPY.md ($pageCopySize B) + RELEASE-NOTES.md ($resetSize B)"
        } else {
            Log "  body = RELEASE-NOTES.md ($resetSize B)  [no RELEASE-PAGE-COPY.md found]"
        }
        $bodyFile = New-TempFile 'json'
        ([ordered]@{
                tag_name         = $Tag
                target_commitish = $Target
                name             = "AIDriven NetDefense $Version"
                body             = $bodyText
                draft            = $true
                prerelease       = $true
            } | ConvertTo-Json -Depth 3) | Set-Content -LiteralPath $bodyFile -Encoding utf8NoBOM
        $r = Invoke-Api -Method POST -Url "$ApiBase/releases" -BodyFile $bodyFile
        Log "  http=$($r.Code)"
        Need ($r.Code -eq 201) "expected 201, got $($r.Code) :: $($r.Raw)"
        Need ([int64]$r.Body.id -gt 0) 'release id missing'
        Need ($r.Body.draft -eq $true) 'draft must be true (a public release before assets exist => updater 404)'
        Need ($r.Body.prerelease -eq $true) 'prerelease must be true for an rc'
        Need ($r.Body.upload_url -match '/releases/\d+/assets') "unexpected upload_url '$($r.Body.upload_url)'"
        $RelId = [int64]$r.Body.id
        $Done.Add(2) | Out-Null
        Log "  ok: release id=$RelId draft=true prerelease=true"

        # STEP 3/4/5 - uploads, latest.json last
        $Script:CurrentStep = 3
        $uploads = @(
            @{ N = 3; File = $setup.name; Size = [int64]$setup.size }
            @{ N = 4; File = $porta.name; Size = [int64]$porta.size }
            @{ N = 5; File = 'latest.json'; Size = [int64](Get-Item (Join-Path $DirAbs 'latest.json')).Length }
        )
        foreach ($u in $uploads) {
            $Script:CurrentStep = $u.N
            $full = Join-Path $DirAbs $u.File
            Log ''
            Log ("STEP {0}/6 :: upload {1} ({2} B)" -f $u.N, $u.File, $u.Size)
            $outFile = New-TempFile 'json'
            $cargs = @('-sS', '-X', 'POST', '-o', $outFile, '-w', '%{http_code}',
                '-H', "Authorization: Bearer $($env:GITHUB_TOKEN)") + $Headers +
                @('-H', 'Content-Type: application/octet-stream',
                  '--data-binary', "@$full",
                  "$UploadBase/releases/$RelId/assets?name=$(Esc $u.File)")
            $codeText = (& $CurlExe @cargs 2>$null) | Select-Object -Last 1
            $code = 0
            [void][int]::TryParse(("$codeText").Trim(), [ref]$code)
            $raw = if (Test-Path $outFile) { Get-Content -LiteralPath $outFile -Raw -Encoding utf8 } else { '' }
            Log "  http=$code"
            Need ($code -eq 201) "expected 201 for $($u.File), got $code :: $raw"
            $asset = $raw | ConvertFrom-Json
            Need ($asset.name -eq $u.File) "asset name '$($asset.name)' != '$($u.File)'"
            Need ([int64]$asset.size -eq $u.Size) "asset size $($asset.size) != local $($u.Size)"
            $Done.Add($u.N) | Out-Null
            Log "  ok: $($u.File) asset id=$($asset.id) size=$($asset.size)"
        }
    } catch {
        Fail-Step $_.Exception.Message
    }

    # STEP 5b - verify order from the server, not from our own bookkeeping.
    $Script:CurrentStep = 5
    Log ''
    Log 'STEP 5b :: GET release and assert ORDER-PROOF'
    $r = Invoke-Api -Method GET -Url "$ApiBase/releases/$RelId"
    Log "  http=$($r.Code)"
    try {
        Need ($r.Code -eq 200) "expected 200, got $($r.Code)"
        $assets = @($r.Body.assets)
        foreach ($a in $assets) { Log ("  asset[{0}] id={1,-10} name={2}" -f [array]::IndexOf($assets, $a), $a.id, $a.name) }
        Need ($assets.Count -eq 3) "assets.length == 3 expected, got $($assets.Count)"
        Need ($assets[0].id -lt $assets[1].id -and $assets[1].id -lt $assets[2].id) 'asset ids must be strictly ascending in upload order'
        Need ($assets[0].name -eq $setup.name) "assets[0] should be $($setup.name)"
        Need ($assets[1].name -eq $porta.name) "assets[1] should be $($porta.name)"
        Need ($assets[2].name -eq 'latest.json') "ORDER-PROOF violated: last asset is '$($assets[2].name)', must be latest.json"
        $maxId = ($assets | Measure-Object -Property id -Maximum).Maximum
        Need ([int64]$assets[2].id -eq [int64]$maxId) 'latest.json asset id must be the maximum'
        Log '  ok: ORDER-PROOF holds (latest.json last, id max, 3 assets)'
        $uploadOrderOk = $true
    } catch {
        Fail-Step $_.Exception.Message
    }

    # STEP 6 - optional publish
    $Script:CurrentStep = 6
    if ($Publish) {
        Log ''
        Log 'STEP 6/6 :: publish draft -> public'
        $bodyFile = New-TempFile 'json'
        '{"draft":false}' | Set-Content -LiteralPath $bodyFile -Encoding utf8NoBOM
        $r = Invoke-Api -Method PATCH -Url "$ApiBase/releases/$RelId" -BodyFile $bodyFile
        Log "  http=$($r.Code)"
        if ($r.Code -ne 200 -or $r.Body.draft -ne $false) {
            Fail-Step "publish failed (http=$($r.Code))"; exit 1
        }
        $Done.Add(6) | Out-Null
        Log '  ok: release is public; latest.json is already in place (steps 1-5 verified)'
    } else {
        Log ''
        Log 'STEP 6/6 :: skipped (-Publish not given). The release is a draft; the updater cannot see it.'
        Log '  to publish: re-run with -Execute -Publish after this run verified steps 1-5.'
    }
    $uploadOrderOk = $true
}

# ---------------------------------------------------------------- verdict
$hard = @($Checks | Where-Object { $_.status -eq 'FAIL' }).Count
$blockList = @($Checks | Where-Object { $_.status -eq 'BLOCKING' })
if ($AllowStaleSource) {
    $blockList = @($blockList | Where-Object { -not ($_.id -eq 'P6' -and $_.detail -match 'snapshot behind') })
}
$block = $blockList.Count
$exitCode = if ($hard -gt 0) { 1 } elseif ($block -gt 0) { 10 } else { 0 }

Head 'PREFLIGHT SUMMARY'
foreach ($c in $Checks) { Log ("  {0,-3} {1,-6} {2}" -f $c.id, $c.status, $c.area) }
Log ''
if ($AllowStaleSource -and @($Checks | Where-Object { $_.id -eq 'P6' -and $_.status -eq 'WARN' }).Count -gt 0) {
    Log 'WARNING (-AllowStaleSource): the export snapshot does not contain the current source bytes.'
    Log '        The tag will point at a commit that is NOT the source of these binaries:'
    Log '        the published .exe/.zip are NOT traceable to the tagged tree. Treat the'
    Log '        release as "built locally, source unpublished" until STEP 0 is done.'
}
if ($exitCode -eq 10 -and @($blockList | Where-Object { $_.id -eq 'P6' }).Count -gt 0) {
    Head 'EXIT 10 :: assets and order are ready; the SOURCE SNAPSHOT blocks the release'
    Log 'The four-row breakdown, the MATCH/BEHIND/MISSING-IN-EXPORT verdicts and the exact'
    Log 'human remedy are in the STEP 0/6 block printed above (every run prints it, including'
    Log 'exit-0 runs). This tail only states what blocks the release:'
    Log '  - P6: the export snapshot does not contain the current source bytes'
    Log '         -> the tag would point at a tree that cannot reproduce these binaries'
    Log 'Nothing was written to GitHub: no tag, no release, no asset upload, no source push.'
}
elseif ($exitCode -eq 10) {
    Head 'EXIT 10 :: preflight BLOCKING (tag state or tag target unverifiable)'
    foreach ($b in $blockList) { Log "  - $($b.id) $($b.area): $($b.detail)" }
    Log 'Fix the item above (delete/wait for the tag, or restore network for ls-remote), then re-run.'
    Log 'Nothing was written; no source sync is implied by this particular block.'
}
Log ''
Log ("MODE={0}  checks: ok={1} warn={2} blocking={3} fail={4}  ->  exit {5}" -f $Mode,
    @($Checks | Where-Object { $_.status -eq 'OK' }).Count,
    @($Checks | Where-Object { $_.status -eq 'WARN' }).Count,
    $block, $hard, $exitCode)
Log "ORDER-PROOF: $(if ($uploadOrderOk) { 'upload order ends with latest.json; release must stay draft until verified' } else { 'not executed (dry-run); plan order ends with latest.json' })"

if ($EvidenceOut) {
    $evDir = if ([IO.Path]::IsPathRooted($EvidenceOut)) { $EvidenceOut } else { Join-Path $Root $EvidenceOut }
    if (-not (Test-Path -LiteralPath $evDir)) { New-Item -ItemType Directory -Path $evDir -Force | Out-Null }
    $payload = [ordered]@{
        generated_at       = (Get-Date).ToString('o')
        mode               = $Mode
        version            = $Version
        tag                = $Tag
        repo               = $Repo
        assets_dir         = $DirAbs
        work_tree          = $TreeAbs
        tag_target         = $Target
        allow_stale_source = [bool]$AllowStaleSource
        checks             = @($Checks)
        source_sync        = @($syncRows)
        disk_assets        = @($Disk.Values)
        exit_code          = $exitCode
        order_proof        = $OrderProof
        upload_order       = @('Setup.exe', 'portable.zip', 'latest.json')
    }
    $jsonPath = Join-Path $evDir 'preflight-result.json'
    $payload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $jsonPath -Encoding utf8NoBOM
    Log "preflight-result.json written: $jsonPath"
}

# ---------------------------------------------------------------- what "ship" means
# Always last, in every mode, so the output answers "what do I type to publish?" without
# scrolling: line 1 builds tag + draft + three assets, line 2 makes the release public.
Log ''
Log 'TO SHIP (real network writes when run; only after STEP 0/6 above shows 4/4 MATCH):'
Log "  pwsh -NoProfile -File scripts/release/release-rc5.ps1 -Execute -ConfirmRelease $Tag"
Log '    steps 1..5: tag -> draft release -> Setup.exe -> portable.zip -> latest.json (LAST)'
Log "  pwsh -NoProfile -File scripts/release/release-rc5.ps1 -Execute -ConfirmRelease $Tag -Publish"
Log '    step 6    : draft -> public; only this makes releases/latest/download/latest.json 200'
exit $exitCode
