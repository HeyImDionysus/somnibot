@echo off
REM ============================================================
REM SomniBot — Start Everything (Windows)
REM Starts Docker services, the bot, and the production dashboard.
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

set "NEEDS_BUILD=0"
if not exist packages\bot\dist set "NEEDS_BUILD=1"
if not exist packages\dashboard\.next\standalone set "NEEDS_BUILD=1"
if not exist packages\dashboard\.next\static set "NEEDS_BUILD=1"

if "%NEEDS_BUILD%"=="1" (
    echo [*] Production build artifacts are missing. Building...
    set "TURBO_TELEMETRY_DISABLED=1"
    set "DO_NOT_TRACK=1"
    call %PNPM_CMD% build
    if %errorlevel% neq 0 (
        echo [X] Build failed. Check the output above for errors.
        pause
        exit /b 1
    )
)

REM ─── Start Docker services ─────────────────────────────────
echo [*] Starting Docker services (Lavalink + Valkey)...

docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Docker is not running. Start Docker Desktop first, then re-run this script.
    pause
    exit /b 1
)

REM Show what Docker actually said. "Check Docker Desktop is running" was
REM printed for every compose failure, including a container-name clash with
REM another checkout of the repo -- which sent operators looking at Docker
REM Desktop while it was running perfectly well.
docker compose up -d 2>"%TEMP%\somni-compose-err.txt"
if %errorlevel% neq 0 (
    echo [X] Docker could not start the services:
    type "%TEMP%\somni-compose-err.txt"
    findstr /i /c:"is already in use" "%TEMP%\somni-compose-err.txt" >nul 2>&1
    if not errorlevel 1 (
        echo.
        echo   This is a name clash, not a Docker problem. container_name is
        echo   pinned in docker-compose.yml, so a second checkout of the repo
        echo   collides with the containers the first one created.
        echo.
        echo   Either start SomniBot from that other directory, or free the
        echo   names with:
        echo       docker rm -f somni-lavalink somni-valkey
    )
    del "%TEMP%\somni-compose-err.txt" >nul 2>&1
    pause
    exit /b 1
)
del "%TEMP%\somni-compose-err.txt" >nul 2>&1
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

REM ─── Start the production dashboard in a new window ─────────
if not defined PORT set "PORT=3000"
if not defined HOSTNAME set "HOSTNAME=127.0.0.1"
set "NODE_ENV=production"
set "NEXT_TELEMETRY_DISABLED=1"
echo [*] Preparing dashboard standalone runtime assets...
node scripts\prepare-dashboard-standalone.mjs
if %errorlevel% neq 0 (
    echo [X] Dashboard standalone preparation failed.
    pause
    exit /b 1
)
echo [*] Starting production dashboard in a new window...
start "SomniBot Dashboard" cmd /c "set NODE_ENV=production&& set PORT=%PORT%&& set HOSTNAME=%HOSTNAME%&& node --env-file=.env packages\dashboard\.next\standalone\packages\dashboard\server.js"
echo   [OK] Dashboard starting on http://localhost:%PORT%
echo.

REM ─── Start the bot (this window) ───────────────────────────
echo [*] Starting bot in this window...
echo.
echo --- Bot logs -----------------------------------------------
echo.

REM Use --env-file to load .env into process.env (Node 22+)
node --env-file=.env packages\bot\dist\index.js
