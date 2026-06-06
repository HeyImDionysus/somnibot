@echo off
REM ============================================================
REM SomniBot — Start Everything (Windows)
REM Starts Docker services, the bot, and the dashboard.
REM Close this window to stop, then run stop.bat.
REM ============================================================

REM Enable UTF-8 output so Unicode characters render correctly
chcp 65001 >nul 2>&1

cd /d "%~dp0\.."

echo.
echo +==========================================+
echo ^|       SomniBot - Starting All Services   ^|
echo +==========================================+
echo.

REM ─── Preflight checks ─────────────────────────────────────
if not exist .env (
    echo [X] No .env file found. Copy .env.example to .env and fill it in first.
    pause
    exit /b 1
)

if not exist node_modules (
    echo [X] Dependencies not installed. Run scripts\setup.bat first.
    pause
    exit /b 1
)

if not exist packages\bot\dist (
    echo [*] Bot not built yet. Building...
    set "PNPM_CMD=pnpm"
    where pnpm >nul 2>&1
    if errorlevel 1 (
        where corepack >nul 2>&1
        if errorlevel 1 (
            echo [X] pnpm not found. Install Node.js 22+ and run: corepack enable
            pause
            exit /b 1
        )
        set "PNPM_CMD=corepack pnpm"
    )
    set "TURBO_TELEMETRY_DISABLED=1"
    set "DO_NOT_TRACK=1"
    call %PNPM_CMD% build
)

REM ─── Start Docker services ─────────────────────────────────
echo [*] Starting Docker services (Lavalink + Valkey)...

docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Docker is not running. Start Docker Desktop first, then re-run this script.
    pause
    exit /b 1
)

docker compose up -d
if %errorlevel% neq 0 (
    echo [X] Failed to start Docker services. Check Docker Desktop is running.
    pause
    exit /b 1
)
echo   [OK] Docker services started
echo.

REM ─── Wait for Lavalink health ──────────────────────────────
echo [*] Waiting for Lavalink to become ready...
set "LAVALINK_READY=0"
for /L %%i in (1,1,30) do (
    curl -s -o nul -w "%%{http_code}" http://localhost:2333/version >nul 2>&1
    if %errorlevel% equ 0 (
        set "LAVALINK_READY=1"
        goto :lavalink_done
    )
    timeout /t 2 /nobreak >nul
)
:lavalink_done
if "%LAVALINK_READY%"=="0" (
    echo   [!] Lavalink did not respond after 60s. Music features may not work.
    echo       Check: docker logs somni-lavalink
) else (
    echo   [OK] Lavalink is ready
)
echo.

REM ─── Write PID file location ────────────────────────────────
REM Store PID file in project root for stop.bat to use
set "PID_FILE=%cd%\.somnibot.pid"

REM ─── Start the dashboard in a new window ────────────────────
echo [*] Starting dashboard in a new window...
start "SomniBot Dashboard" cmd /c "cd packages\dashboard && npx next dev --turbopack --port 3000"
echo   [OK] Dashboard starting on http://localhost:3000
echo.

REM ─── Start the bot (this window) ───────────────────────────
echo [*] Starting bot in this window...
echo.
echo --- Bot logs -----------------------------------------------
echo.

REM Use --env-file to load .env into process.env (Node 22+)
node --env-file=.env packages\bot\dist\index.js
