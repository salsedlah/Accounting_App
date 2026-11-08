param()
$ErrorActionPreference = 'Stop'

$apiBaseUrl = $env:HISAB_API_BASE_URL
if ([string]::IsNullOrWhiteSpace($apiBaseUrl)) {
  throw 'Set HISAB_API_BASE_URL to the deployed HTTPS API URL before building a production bundle.'
}
$parsedApiUrl = $null
if (-not [Uri]::TryCreate($apiBaseUrl, [UriKind]::Absolute, [ref]$parsedApiUrl)) {
  throw 'HISAB_API_BASE_URL must be a valid absolute URL.'
}
$apiAddress = $null
$isPrivateAddress = $false
if ([System.Net.IPAddress]::TryParse($parsedApiUrl.Host, [ref]$apiAddress)) {
  $octets = $apiAddress.GetAddressBytes()
  if ($apiAddress.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
    $isPrivateAddress = $octets[0] -eq 0 -or $octets[0] -eq 10 -or $octets[0] -eq 127 -or
      ($octets[0] -eq 169 -and $octets[1] -eq 254) -or
      ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
      ($octets[0] -eq 192 -and $octets[1] -eq 168)
  } else {
    $isPrivateAddress = $apiAddress.IsLoopback -or $apiAddress.IsIPv6LinkLocal -or
      (($octets[0] -band 0xfe) -eq 0xfc)
  }
}
if ($parsedApiUrl.Scheme -ne 'https' -or $parsedApiUrl.IsLoopback -or $parsedApiUrl.Host.EndsWith('.local') -or $isPrivateAddress -or $parsedApiUrl.UserInfo -or $parsedApiUrl.Query -or $parsedApiUrl.Fragment) {
  throw 'Production API must use a public HTTPS host; localhost and local network addresses are not supported.'
}

$requiredSigningVariables = @(
  'ANDROID_KEYSTORE_PATH',
  'ANDROID_KEYSTORE_PASSWORD',
  'ANDROID_KEY_ALIAS',
  'ANDROID_KEY_PASSWORD'
)
foreach ($name in $requiredSigningVariables) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
    throw "Set $name to configure Android production signing."
  }
}
if (-not (Test-Path -LiteralPath $env:ANDROID_KEYSTORE_PATH -PathType Leaf)) {
  throw 'ANDROID_KEYSTORE_PATH does not point to a keystore file.'
}
$env:ANDROID_KEYSTORE_PATH = (Resolve-Path -LiteralPath $env:ANDROID_KEYSTORE_PATH).Path
$offlineAuthPolicy = $env:HISAB_OFFLINE_AUTH_POLICY
if ([string]::IsNullOrWhiteSpace($offlineAuthPolicy)) {
  $offlineAuthPolicy = 'cached-credentials'
}

Push-Location $PSScriptRoot
try {
  $env:HISAB_API_BASE_URL = $apiBaseUrl
  & flutter build appbundle --release `
    "--dart-define=API_BASE_URL=$apiBaseUrl" `
    "--dart-define=ALLOW_SERVER_OVERRIDE=false" `
    "--dart-define=OFFLINE_AUTH_POLICY=$offlineAuthPolicy"
  if ($LASTEXITCODE -ne 0) {
    throw "Flutter production bundle build failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}

