# POS one-shot setup for a fresh Windows 10/11 PC.
#
# Installs Git, Node.js 22 LTS and XAMPP (MySQL), clones Pos-Backend,
# Pos-Frontend and Pos-Desktop side by side, runs npm install in each, writes
# the backend .env, creates the `pos` database from schema.sql + seeders.sql,
# and puts a "POS Launcher" shortcut on the Desktop.
#
# Run from an Administrator PowerShell:
#   irm https://raw.githubusercontent.com/Abdulmusavvir1999/Mandi-POS-Desktop-App/main/setup.ps1 | iex
#
# Install folder defaults to Desktop\Pos; set $env:POS_DIR first to change it.
# Safe to re-run: installed tools are skipped, existing repos are pulled, an
# existing .env is kept, and the database is only seeded when it is empty.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$InstallDir = if ($env:POS_DIR) { $env:POS_DIR } else { Join-Path ([Environment]::GetFolderPath('Desktop')) 'Pos' }
$GitHub = 'https://github.com/Abdulmusavvir1999'
$Repos = [ordered]@{
  'Pos-Backend'  = "$GitHub/Mandi-POS-BE.git"
  'Pos-Frontend' = "$GitHub/Mandi-POS-FE.git"
  'Pos-Desktop'  = "$GitHub/Mandi-POS-Desktop-App.git"
}
# The launcher's DEFAULT_CONFIG points at this XAMPP location.
$XamppDir = 'C:\xampp'
$MysqlBin = Join-Path $XamppDir 'mysql\bin'
$DbName = 'pos'

function Step($msg) { Write-Host ''; Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host ''; Write-Host "SETUP FAILED: $msg" -ForegroundColor Red; throw $msg }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Test-Port($port) {
  $c = New-Object Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $port); return $true } catch { return $false } finally { $c.Close() }
}

function Install-WingetPackage($id, $name, [scriptblock]$isInstalled) {
  if (& $isInstalled) { Ok "$name already installed"; return }
  Write-Host "    Installing $name (this can take a few minutes)..."
  winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
  Refresh-Path
  if (-not (& $isInstalled)) { Fail "$name did not install (winget exit code $LASTEXITCODE). Install it by hand and re-run this script." }
  Ok "$name installed"
}

function Invoke-Native([string]$what, [scriptblock]$cmd) {
  & $cmd
  if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE)" }
}

# --- 0. Preconditions --------------------------------------------------------
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Fail 'Open PowerShell with "Run as administrator" and paste the command again.' }
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Fail 'winget is missing. Install "App Installer" from the Microsoft Store, then re-run.'
}
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

# --- 1. Tools ----------------------------------------------------------------
Step 'Installing Git, Node.js 22 LTS and XAMPP'
Refresh-Path
Install-WingetPackage 'Git.Git' 'Git' { [bool](Get-Command git -ErrorAction SilentlyContinue) }
Install-WingetPackage 'OpenJS.NodeJS.22' 'Node.js 22 LTS' { [bool](Get-Command node -ErrorAction SilentlyContinue) }
Install-WingetPackage 'ApacheFriends.Xampp.8.2' 'XAMPP' { Test-Path (Join-Path $MysqlBin 'mysqld.exe') }
Ok ("node " + (node -v) + ", npm " + (npm -v) + ", " + (git --version))

# --- 2. Source ---------------------------------------------------------------
Step "Getting the project into $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
foreach ($name in $Repos.Keys) {
  $dir = Join-Path $InstallDir $name
  if (Test-Path (Join-Path $dir '.git')) {
    Invoke-Native "git pull in $name" { git -C $dir pull --ff-only }
    Ok "$name updated"
  } else {
    Invoke-Native "git clone $name" { git clone $Repos[$name] $dir }
    Ok "$name cloned"
  }
}

# --- 3. Dependencies (Angular, Express, Electron, ...) ------------------------
Step 'Installing npm packages (Angular 19, Express 4, Electron 31, ...)'
foreach ($name in $Repos.Keys) {
  Write-Host "    npm install in $name..."
  Push-Location (Join-Path $InstallDir $name)
  try { Invoke-Native "npm install in $name" { npm install --no-audit --no-fund } } finally { Pop-Location }
  Ok "$name packages installed"
}

# --- 4. Backend .env -----------------------------------------------------------
Step 'Writing Pos-Backend\.env'
$backend = Join-Path $InstallDir 'Pos-Backend'
$envFile = Join-Path $backend '.env'
if (Test-Path $envFile) {
  Ok '.env already exists, left as is'
} else {
  function New-Secret { -join ((1..48) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) }) }
  # XAMPP's MySQL ships with user root and an empty password. The app reads
  # LOC_DB_*, the migrator scripts read DB_*, so both are set.
  $values = @{
    'JWT_SECRET' = New-Secret; 'JWT_REFRESH_SECRET' = New-Secret
    'LOC_DB_HOST' = 'localhost'; 'LOC_DB_PORT' = '3306'; 'LOC_DB_USER' = 'root'; 'LOC_DB_PASS' = ''; 'LOC_DB_NAME' = $DbName
    'DB_HOST' = 'localhost'; 'DB_PORT' = '3306'; 'DB_USER' = 'root'; 'DB_PASSWORD' = ''; 'DB_NAME' = $DbName
  }
  $lines = Get-Content (Join-Path $backend '.env.example') | ForEach-Object {
    if ($_ -match '^([A-Z_]+)=' -and $values.ContainsKey($Matches[1])) { "$($Matches[1])=$($values[$Matches[1]])" } else { $_ }
  }
  # No BOM, so dotenv reads the first key correctly.
  [IO.File]::WriteAllText($envFile, ($lines -join "`r`n") + "`r`n", (New-Object Text.UTF8Encoding $false))
  Ok '.env written (MySQL user root, random JWT secrets)'
}

# --- 5. Database ---------------------------------------------------------------
Step "Creating the '$DbName' database"
$mysql = Join-Path $MysqlBin 'mysql.exe'
$startedMysql = $false
if (-not (Test-Port 3306)) {
  Start-Process -FilePath (Join-Path $MysqlBin 'mysqld.exe') -ArgumentList "--defaults-file=`"$MysqlBin\my.ini`"", '--standalone' -WorkingDirectory $MysqlBin -WindowStyle Hidden
  $startedMysql = $true
  $deadline = (Get-Date).AddSeconds(40)
  while (-not (Test-Port 3306)) {
    if ((Get-Date) -gt $deadline) { Fail "MySQL did not start. See $XamppDir\mysql\data\mysql_error.log" }
    Start-Sleep -Milliseconds 500
  }
}
Ok 'MySQL is running'

Invoke-Native 'CREATE DATABASE' { & $mysql -u root -e "CREATE DATABASE IF NOT EXISTS $DbName CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci" }
$tableCount = & $mysql -u root -N -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$DbName'"
if ([int]$tableCount -gt 0) {
  Ok "Database already has $tableCount tables, not touching its data"
} else {
  # cmd's < redirect passes the files byte for byte; a PowerShell pipe would
  # re-encode them and mangle the Arabic dish names in the seed data.
  foreach ($file in 'schema.sql', 'seeders.sql') {
    $path = Join-Path $backend "src\database\$file"
    Invoke-Native "import $file" { cmd /s /c "`"`"$mysql`" -u root --default-character-set=utf8mb4 $DbName < `"$path`"`"" }
    Ok "$file imported"
  }
}

# Leave MySQL stopped so the launcher starts and owns it.
if ($startedMysql) {
  & (Join-Path $MysqlBin 'mysqladmin.exe') -u root shutdown | Out-Null
  Ok 'MySQL stopped again (the launcher starts it)'
}

# --- 6. Desktop shortcut ---------------------------------------------------------
Step 'Creating the "POS Launcher" Desktop shortcut'
$desktopApp = Join-Path $InstallDir 'Pos-Desktop'
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'POS Launcher.lnk'
$sc = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$sc.TargetPath = 'wscript.exe'
$sc.Arguments = "`"$(Join-Path $desktopApp 'Launch.vbs')`""
$sc.WorkingDirectory = $desktopApp
$sc.IconLocation = (Join-Path $desktopApp 'node_modules\electron\dist\electron.exe') + ',0'
$sc.Save()
Ok $lnk

Write-Host ''
Write-Host '=====================================================' -ForegroundColor Green
Write-Host ' POS setup complete' -ForegroundColor Green
Write-Host '=====================================================' -ForegroundColor Green
Write-Host " Project : $InstallDir"
Write-Host ' Start   : double-click "POS Launcher" on the Desktop, then "Start everything"'
Write-Host ' Open    : http://localhost:8002'
Write-Host ' Login   : admin / Super@123   (also superadmin, manager, cashier, staff)'
Write-Host ''
