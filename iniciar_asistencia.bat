@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$secure = Read-Host 'Contrasena de PostgreSQL' -AsSecureString; $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer); Set-Location -LiteralPath '%~dp0'; node servidor.js; exit $LASTEXITCODE } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose(); Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }"
if errorlevel 1 pause
