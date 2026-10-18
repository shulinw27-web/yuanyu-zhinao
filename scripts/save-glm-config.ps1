# Run in an interactive local console. No key in arguments, history, or output.
$ErrorActionPreference = 'Stop'
$glmDirectory = 'D:\wsl\private\yuanyu-zhinao\glm'
$glmFile = Join-Path $glmDirectory 'glm.json'
if (Test-Path -LiteralPath $glmFile) { throw 'GLM configuration already exists; no file was overwritten.' }
$glmParent = Split-Path -Parent $glmDirectory
if (-not (Test-Path -LiteralPath $glmParent)) { throw 'Private parent directory is missing.' }
if ((Get-Item -LiteralPath $glmParent).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Private parent cannot be a reparse point.' }
if (-not (Test-Path -LiteralPath $glmDirectory)) { New-Item -ItemType Directory -Path $glmDirectory | Out-Null }
if ((Get-Item -LiteralPath $glmDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Private directory cannot be a reparse point.' }
# Restrict only the dedicated GLM directory. Leave Ark and other configs alone.
$glmSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$glmAcl = Get-Acl -LiteralPath $glmDirectory
$glmAcl.SetAccessRuleProtection($true, $false)
foreach ($glmRule in @($glmAcl.Access)) { [void]$glmAcl.RemoveAccessRuleSpecific($glmRule) }
$glmAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($glmSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
Set-Acl -LiteralPath $glmDirectory -AclObject $glmAcl
$glmVerifiedAcl = Get-Acl -LiteralPath $glmDirectory
if (-not $glmVerifiedAcl.AreAccessRulesProtected -or $glmVerifiedAcl.Access.Count -eq 0) { throw 'Private ACL verification failed.' }
foreach ($glmRule in $glmVerifiedAcl.Access) {
  if ($glmRule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $glmSid.Value) { throw 'Private ACL includes another identity.' }
}
Write-Host 'Yuanyu GLM setup: ordinary BigModel API (not Coding Plan).'
$glmModel = Read-Host 'Model ID (press Enter for glm-5)'
if (-not $glmModel) { $glmModel = 'glm-5' }
if ($glmModel -notmatch '^glm-[a-z0-9._-]{1,80}$') { throw 'Invalid model ID; nothing was saved.' }
$glmSecret = Read-Host 'Paste GLM API Key here (hidden input)' -AsSecureString
$glmPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($glmSecret)
try {
  $glmPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($glmPointer).Trim()
  if ($glmPlain -notmatch '^[A-Za-z0-9._-]{20,512}$') { throw 'Invalid key format; nothing was saved.' }
  $glmJson = @{ apiKey = $glmPlain; model = $glmModel; baseUrl = 'https://open.bigmodel.cn/api/paas/v4'; allowedModels = @($glmModel) } | ConvertTo-Json
  $glmBytes = [Text.UTF8Encoding]::new($false).GetBytes($glmJson)
  $glmStream = [IO.File]::Open($glmFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $glmStream.Write($glmBytes, 0, $glmBytes.Length) } finally { $glmStream.Dispose() }
  Write-Host ('Saved to ' + $glmFile + '. Key is not displayed. No API call or provider switch has occurred.')
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($glmPointer)
  $glmSecret.Dispose()
  $glmPlain = $null; $glmJson = $null
  if ($glmBytes) { [Array]::Clear($glmBytes, 0, $glmBytes.Length) }
}
Read-Host 'Finished. Press Enter to close' | Out-Null
