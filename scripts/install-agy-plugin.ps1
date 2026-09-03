[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)]
  [switch]$ConfirmInstall,
  [string]$Agy = "agy.exe",
  [string]$PluginPath
)

if (-not $ConfirmInstall) {
  throw "Refusing to install. Re-run with -ConfirmInstall after reviewing the local plugin."
}
if ([string]::IsNullOrWhiteSpace($PluginPath)) {
  $PluginPath = Join-Path $PSScriptRoot "..\agy-plugin"
}
$resolvedPlugin = (Resolve-Path -LiteralPath $PluginPath -ErrorAction Stop).Path
if ($PSCmdlet.ShouldProcess($resolvedPlugin, "Install Agy plugin")) {
  & $Agy plugin install $resolvedPlugin
  if ($LASTEXITCODE -ne 0) {
    throw "agy plugin install failed with exit code $LASTEXITCODE"
  }
}
