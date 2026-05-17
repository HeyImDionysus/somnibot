@echo off
REM ============================================================
REM SomniBot — Start Everything (Windows)
REM Starts Docker services, the bot, and the dashboard.
REM Close this window to stop, then run stop.bat.
REM ============================================================

cd /d "%~dp0\.."

echo.
echo ╔══════════════════════════════════════════╗
echo ║       SomniBot — Starting All Services   ║
echo ╚══════════════════════════════════════════╝
echo.

REM ─── Preflight checks ─────────────────────────────────────
if not exist .env (
    echo ❌ No .env file found. Copy .env.example to .env and fill it in first.
    pause
    exit /b 1
)

if not exist node_modules (
    echo ❌ Dependencies not installed. Run: pnpm install ^&^& pnpm build
    pause
    exit /b 1
)

if not exist packages\bot\dist (
    echo → Bot not built yet. Building...
    call pnpm build
)

REM ─── Start Docker services ─────────────────────────────────
echo → Starting Docker services (Lavalink + Valkey)...
docker compose up -d
echo   ✅ Docker services started
echo.

REM ─── Wait for Lavalink ──────────────────────────────────────
echo → Waiting 20 seconds for Lavalink to boot...
timeout /t 20 /nobreak >nul
echo   ✅ Lavalink should be ready
echo.

REM ─── Start the dashboard in a new window ────────────────────
echo → Starting dashboard in a new window...
start "SomniBot Dashboard" cmd /c "cd packages\dashboard && npx next dev --turbopack --port 3000"
echo   ✅ Dashboard starting on http://localhost:3000
echo.

REM ─── Start the bot (this window) ───────────────────────────
echo → Starting bot in this window...
echo.
echo ─── Bot logs ────────────────────────────────────────────
echo.

node packages\bot\dist\index.js
