@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\sync-skills.ps1" %*
set "AI_SOLO_STATUS=%ERRORLEVEL%"
if not "%AI_SOLO_STATUS%"=="0" (
  echo.
  echo Skill sync did not complete. Review the message above.
)
if /I not "%AI_SOLO_NO_PAUSE%"=="1" (
  echo.
  echo You can close this window.
  pause
)
exit /b %AI_SOLO_STATUS%
