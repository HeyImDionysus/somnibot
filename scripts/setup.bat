@echo off
REM ============================================================
REM SomniBot — First-Time Setup (Windows)
REM Run this once after cloning the repo.
REM ============================================================

REM Enable UTF-8 output so Unicode characters render correctly
chcp 65001 >nul 2>&1

cd /d "%~dp0\.."

echo.
echo +==========================================+
echo ^|         SomniBot - First-Time Setup      ^|
echo +==========================================+
echo.

REM ─── Check prerequisites ──────────────────────────────────
echo [1/5] Checking prerequisites...

REM ── Node.js ──
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo   [X] Node.js not found. Download from https://nodejs.org ^(v22+^)
    pause
    exit /b 1
)

REM Verify Node.js version >= 22
for /f "tokens=1 delims=v" %%A in ('node -v') do set "NODE_RAW=%%A"
for /f "tokens=1 delims=." %%M in ("%NODE_RAW%") do set "NODE_MAJOR=%%M"
if %NODE_MAJOR% LSS 22 (
    echo   [X] Node.js v%NODE_RAW% found, but v22+ is required.
    echo       Download the latest LTS from https://nodejs.org
    pause
    exit /b 1
)
echo   [OK] Node.js v%NODE_RAW%

REM ── pnpm ──
set "PNPM_CMD=pnpm"
where pnpm >nul 2>&1
if errorlevel 1 (
    where corepack >nul 2>&1
    if errorlevel 1 (
        echo   [X] pnpm not found. Install Node.js 22+ and run: corepack enable
        pause
        exit /b 1
    )
    set "PNPM_CMD=corepack pnpm"
)
call %PNPM_CMD% -v >nul 2>&1
if errorlevel 1 (
    echo   [X] pnpm is not available through %PNPM_CMD%. Run: corepack enable
    pause
    exit /b 1
)
echo   [OK] pnpm available via %PNPM_CMD%

REM ── Docker ──
where docker >nul 2>&1
if %errorlevel% neq 0 (
    echo   [X] Docker not found. Download Docker Desktop from https://docker.com/get-started
    pause
    exit /b 1
)

REM Verify Docker daemon is running
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo   [!] Docker is installed but not running.
    echo       Start Docker Desktop and wait for it to finish loading, then re-run this script.
    pause
    exit /b 1
)
echo   [OK] Docker found and running
echo.

REM ─── Create .env ──────────────────────────────────────────
echo [2/5] Checking environment file...
if not exist .env (
    copy .env.example .env >nul
    echo   [OK] Created .env from .env.example
    echo.
    echo   !! IMPORTANT: Open .env in a text editor and fill in your values.
    echo      At minimum you need:
    echo        DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_CLIENT_SECRET
    echo        SUPABASE_URL, SUPABASE_SECRET_KEY
    echo        NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    echo        CSRF_SECRET, NEXTAUTH_SECRET ^(generate each with: openssl rand -hex 32^)
    echo.
) else (
    echo   [OK] .env already exists, skipping.
    echo.
)

REM ─── Install dependencies ─────────────────────────────────
echo [3/5] Installing dependencies (this may take a minute)...

REM Suppress Node.js deprecation warnings from pnpm internals
set "NODE_NO_WARNINGS=1"
call %PNPM_CMD% install
set "NODE_NO_WARNINGS="

if %errorlevel% neq 0 (
    echo   [X] Dependency installation failed. Check the output above for errors.
    pause
    exit /b 1
)
echo   [OK] Dependencies installed
echo.

REM ─── Build ─────────────────────────────────────────────────
echo [4/5] Building all packages...

REM Disable Turborepo telemetry prompt
set "TURBO_TELEMETRY_DISABLED=1"
set "DO_NOT_TRACK=1"

call %PNPM_CMD% build

if %errorlevel% neq 0 (
    echo   [X] Build failed. Check the output above for errors.
    pause
    exit /b 1
)
echo   [OK] Build complete
echo.

REM ─── Pull Docker images ────────────────────────────────────
echo [5/5] Pulling Docker images (Lavalink + Valkey)...
docker compose pull >nul 2>&1
if %errorlevel% neq 0 (
    echo   [!] Docker image pull failed. You can still start manually with: docker compose up -d
) else (
    echo   [OK] Docker images ready
)
echo.

echo +==========================================+
echo ^|           Setup Complete!                ^|
echo +==========================================+
echo.
echo Next steps:
echo   1. Fill in your .env file (if you haven't already)
echo   2. Run: scripts\start.bat
echo.
pause
