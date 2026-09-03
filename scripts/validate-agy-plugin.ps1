[CmdletBinding()]
param(
  [string]$Agy = "agy.exe",
  [string]$PluginPath
)

if ([string]::IsNullOrWhiteSpace($PluginPath)) {
  $PluginPath = Join-Path $PSScriptRoot "..\agy-plugin"
}
$resolvedPlugin = (Resolve-Path -LiteralPath $PluginPath -ErrorAction Stop).Path
Write-Host "Validating local Agy plugin: $resolvedPlugin"
& $Agy plugin validate $resolvedPlugin
if ($LASTEXITCODE -ne 0) {
  throw "agy plugin validate failed with exit code $LASTEXITCODE"
}
Write-Host "Agy plugin validation passed. No plugin was installed."
