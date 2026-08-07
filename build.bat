@echo off
REM Subtitle-for-G one-click build for Windows
REM
REM Prerequisites (install once):
REM   1. Rust toolchain: https://rustup.rs  (keep the default MSVC target)
REM   2. Visual Studio 2022 Build Tools with workload "Desktop development with C++"
REM   3. WebView2 Runtime (already present on Win10/11)
REM
REM IMPORTANT: run this script from a "Developer Command Prompt for VS"
REM or "x64 Native Tools Command Prompt for VS" so that link.exe is on PATH,
REM otherwise cargo build will fail at the linking step.
REM
REM This script lives at the project root (my-first-project/build.bat).

cd /d %~dp0

echo [1/4] npm install (pulls @tauri-apps/cli)
call npm install
if errorlevel 1 goto fail

echo [2/4] generate icons (safe to re-run)
call npm run icons
if errorlevel 1 goto fail

echo [3/4] copy frontend into dist/ for Tauri packaging
call npm run build
if errorlevel 1 goto fail

echo [4/4] compile Tauri -> single .exe (downloads Rust crates on first run)
call npm run tauri:build
if errorlevel 1 goto fail

echo.
echo Done. Artifact:
echo   src-tauri/target/release/Subtitle-for-G.exe
goto end

:fail
echo.
echo Build step failed. Check the output above.
pause
exit /b 1

:end
pause
