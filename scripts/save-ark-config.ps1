# Run locally. The key is entered interactively, never as a command argument.
$ErrorActionPreference = 'Stop'
$arkDirectory = 'D:\wsl\private\yuanyu-zhinao'
$arkFile = Join-Path $arkDirectory 'ark.json'
if (Test-Path -LiteralPath $arkFile) { throw 'Configuration already exists; no file was overwritten.' }
if (-not (Test-Path -LiteralPath $arkDirectory)) { New-Item -ItemType Directory -Path $arkDirectory | Out-Null }
if ((Get-Item -LiteralPath $arkDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Private directory cannot be a reparse point.' }

# Protect only this dedicated directory. Preserve the owner and avoid SACL or
# machine-wide permission changes. Abort rather than save with broad access.
$arkSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$arkAcl = Get-Acl -LiteralPath $arkDirectory
$arkAlreadyPrivate = $arkAcl.AreAccessRulesProtected -and $arkAcl.Access.Count -gt 0
foreach ($arkRule in $arkAcl.Access) {
  if ($arkRule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $arkSid.Value) { $arkAlreadyPrivate = $false }
}
if (-not $arkAlreadyPrivate) {
  $arkAcl.SetAccessRuleProtection($true, $false)
  foreach ($arkRule in @($arkAcl.Access)) { [void]$arkAcl.RemoveAccessRuleSpecific($arkRule) }
  $arkAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($arkSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  Set-Acl -LiteralPath $arkDirectory -AclObject $arkAcl
}
$arkVerifiedAcl = Get-Acl -LiteralPath $arkDirectory
if (-not $arkVerifiedAcl.AreAccessRulesProtected) { throw 'Private directory ACL verification failed.' }
foreach ($arkRule in $arkVerifiedAcl.Access) {
  if ($arkRule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $arkSid.Value) { throw 'Private directory ACL includes another identity.' }
}

$arkSecret = Read-Host 'Paste yuanyu-zhinao API Key (hidden input)' -AsSecureString
$arkPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($arkSecret)
$arkPlain = $null
try {
  $arkPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($arkPointer).Trim()
  if ($arkPlain -notmatch '^[A-Za-z0-9._-]{20,256}$') { throw 'Invalid key format; nothing was saved.' }
  $arkModel = 'doubao-seed-2-1-pro-260628'
  $arkJson = @{ apiKey = $arkPlain; model = $arkModel; baseUrl = 'https://ark.cn-beijing.volces.com/api/v3'; allowedModels = @($arkModel) } | ConvertTo-Json
  $arkBytes = [Text.UTF8Encoding]::new($false).GetBytes($arkJson)
  $arkStream = [IO.File]::Open($arkFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $arkStream.Write($arkBytes, 0, $arkBytes.Length) } finally { $arkStream.Dispose() }
  Write-Output 'Saved private Ark configuration. Key is not displayed. Run npm run check:ark next.'
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($arkPointer)
  $arkSecret.Dispose()
  $arkPlain = $null
  $arkJson = $null
  if ($arkBytes) { [Array]::Clear($arkBytes, 0, $arkBytes.Length) }
}
