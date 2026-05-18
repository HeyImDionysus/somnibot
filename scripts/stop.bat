@echo off
REM ============================================================
REM SomniBot — Stop Everything (Windows)
REM ============================================================

REM Enable UTF-8 output so Unicode characters render correctly
chcp 65001 >nul 2>&1

cd /d "%~dp0\.."

echo.
echo [*] Stopping SomniBot...

REM ── Stop Docker services ──
echo   [*] Stopping Docker services...
docker compose down >nul 2>&1
echo   [OK] Docker services stopped

REM ── Stop SomniBot windows ──
echo   [*] Stopping SomniBot windows...

REM Only kill windows with SomniBot titles (not all node processes)
taskkill /f /fi "WINDOWTITLE eq SomniBot Dashboard*" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq SomniBot*" >nul 2>&1

echo.
echo [OK] Done. If the bot window is still open, close it manually (Ctrl+C or close the window).
echo.
pause
