@echo off
REM ============================================================
REM SomniBot — Stop Everything (Windows)
REM ============================================================

cd /d "%~dp0\.."

echo.
echo → Stopping SomniBot...

echo   → Stopping Docker services...
docker compose down 2>nul
echo   ✅ Docker services stopped

echo   → Stopping bot and dashboard processes...
taskkill /f /fi "WINDOWTITLE eq SomniBot*" >nul 2>&1
taskkill /f /im "node.exe" /fi "MEMUSAGE gt 50000" >nul 2>&1

echo.
echo ✅ Done. (If the bot window is still open, close it manually.)
echo.
pause
