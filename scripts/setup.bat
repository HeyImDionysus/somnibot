@echo off
REM ============================================================
REM SomniBot — First-Time Setup (Windows)
REM Run this once after cloning the repo.
REM ============================================================

cd /d "%~dp0\.."

echo.
echo ╔══════════════════════════════════════════╗
echo ║         SomniBot — First-Time Setup      ║
echo ╚══════════════════════════════════════════╝
echo.

REM ─── Check prerequisites ──────────────────────────────────
echo → Checking prerequisites...

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Node.js not found. Download from https://nodejs.org ^(v22+^)
    pause
    exit /b 1
)
echo   ✅ Node.js found

where pnpm >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ pnpm not found. Run: corepack enable ^&^& corepack prepare pnpm@9 --activate
    pause
    exit /b 1
)
echo   ✅ pnpm found

where docker >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Docker not found. Download Docker Desktop from https://docker.com/get-started
    pause
    exit /b 1
)
echo   ✅ Docker found
echo.

REM ─── Create .env ──────────────────────────────────────────
if not exist .env (
    echo → Creating .env from .env.example...
    copy .env.example .env >nul
    echo   ✅ Created .env
    echo.
    echo   ⚠️  IMPORTANT: Open .env in a text editor and fill in your values.
    echo      At minimum you need:
    echo        DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_CLIENT_SECRET
    echo        SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
    echo.
) else (
    echo → .env already exists, skipping.
)

REM ─── Install dependencies ─────────────────────────────────
echo → Installing dependencies (this may take a minute)...
call pnpm install
echo   ✅ Dependencies installed
echo.

REM ─── Build ─────────────────────────────────────────────────
echo → Building all packages...
call pnpm build
echo   ✅ Build complete
echo.

echo ╔══════════════════════════════════════════╗
echo ║            ✅ Setup Complete!             ║
echo ╚══════════════════════════════════════════╝
echo.
echo Next steps:
echo   1. Fill in your .env file (if you haven't already)
echo   2. Run: scripts\start.bat
echo.
pause
