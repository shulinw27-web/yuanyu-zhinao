# Interactive credential entry only. Never put an API key in shell arguments.
$ErrorActionPreference = 'Stop'
$weknoraDirectory = 'D:\wsl\private\yuanyu-zhinao'
$weknoraFile = Join-Path $weknoraDirectory 'weknora.local.json'
if (Test-Path -LiteralPath $weknoraFile) { throw 'Configuration already exists; no file was overwritten.' }
if (-not (Test-Path -LiteralPath $weknoraDirectory -PathType Container)) { throw 'Prepare the private directory first.' }
if ((Get-Item -LiteralPath $weknoraDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Private directory cannot be a reparse point.' }
$weknoraSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$weknoraAcl = Get-Acl -LiteralPath $weknoraDirectory
if (-not $weknoraAcl.AreAccessRulesProtected -or $weknoraAcl.Access.Count -eq 0) { throw 'Private directory ACL is not protected; nothing saved.' }
foreach ($weknoraRule in $weknoraAcl.Access) {
  if ($weknoraRule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $weknoraSid) { throw 'Private directory grants access to another identity; nothing saved.' }
}
$weknoraPrincipal = (Read-Host 'Current project identity fingerprint (64 hex characters, shown in knowledge diagnostics)').Trim()
if ($weknoraPrincipal -notmatch '^[a-f0-9]{64}$') { throw 'Invalid principal fingerprint.' }
$weknoraTenant = (Read-Host 'WeKnora workspace numeric ID').Trim()
if ($weknoraTenant -notmatch '^[1-9][0-9]{0,14}$') { throw 'Invalid workspace ID.' }
$weknoraKb = (Read-Host 'Allowed WeKnora knowledge base ID').Trim()
$weknoraDocs = @((Read-Host 'Allowed document IDs (comma separated)').Split(',') | ForEach-Object { $_.Trim() } | Select-Object -Unique)
if ($weknoraKb -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$' -or $weknoraDocs.Count -lt 1 -or $weknoraDocs.Count -gt 32) { throw 'Invalid resource scope.' }
foreach ($weknoraDoc in $weknoraDocs) { if ($weknoraDoc -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$') { throw 'Invalid document ID.' } }
$weknoraSecret = Read-Host 'Paste the dedicated READ-ONLY WeKnora API Key (hidden input, not the Ark key)' -AsSecureString
$weknoraPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($weknoraSecret)
try {
  $weknoraPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($weknoraPointer).Trim()
  if ($weknoraPlain.Length -lt 8 -or $weknoraPlain.Length -gt 4096 -or $weknoraPlain -match '\s') { throw 'Invalid key format; nothing saved.' }
  $weknoraJson = @{ schemaVersion = 1; enabled = $true; baseUrl = 'http://127.0.0.1:18081'; apiKey = $weknoraPlain;
    timeoutMs = 5000; retrievalMode = 'keyword_only'; bindings = @(@{ principalKey = $weknoraPrincipal; tenantId = [long]$weknoraTenant; knowledgeBaseId = $weknoraKb; knowledgeIds = $weknoraDocs }) } | ConvertTo-Json -Depth 6
  $weknoraBytes = [Text.UTF8Encoding]::new($false).GetBytes($weknoraJson)
  $weknoraStream = [IO.File]::Open($weknoraFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $weknoraStream.Write($weknoraBytes, 0, $weknoraBytes.Length) } finally { $weknoraStream.Dispose() }
  Write-Output 'Saved private WeKnora configuration; key is not displayed. Set WEKNORA_CONFIG_FILE on the API process. Hybrid remains opt-in.'
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($weknoraPointer)
  $weknoraSecret.Dispose(); $weknoraPlain = $null; $weknoraJson = $null
  if ($weknoraBytes) { [Array]::Clear($weknoraBytes, 0, $weknoraBytes.Length) }
}
