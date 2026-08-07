@echo off
REM Subtitle-for-G - Python(pywebview) 单文件 .exe 构建脚本
REM 用法：双击本文件，或在 CMD/PowerShell 中运行它。
REM 前置：已安装 Python 3.10+（并将 python 加入 PATH）。无需 Rust / Visual Studio。
REM 产物：build_exe\Subtitle-for-G.exe（单个文件，双击即用）

cd /d %~dp0

REM 1) 可选：建虚拟环境并激活（避免污染系统 Python）
IF NOT EXIST .venv (
  python -m venv .venv
)
call .venv\Scripts\activate.bat

REM 2) 安装依赖
pip install -r python_app\requirements.txt

REM 3) 构建前端（输出到 dist/）
call npm run build

REM 4) 把前端拷进 python_app\dist，供 PyInstaller 一并打包
if not exist python_app\dist mkdir python_app\dist
xcopy /E /I /Y dist\* python_app\dist\

REM 5) 用 PyInstaller 打单文件可执行（--windowed 无控制台窗口）
REM    --collect-submodules webview 确保把 pywebview 的 edgechromium 平台模块一并打进包，
REM    否则打包后的 exe 在 Windows 上会报 ImportError / 无法创建窗口。
pyinstaller --noconfirm --onefile --windowed ^
  --name Subtitle-for-G ^
  --distpath build_exe --workpath build_tmp ^
  --hidden-import webview ^
  --collect-submodules webview ^
  --add-data "python_app\dist;dist" ^
  python_app\main.py

echo.
echo Build done. Exe: %~dp0build_exe\Subtitle-for-G.exe
pause
