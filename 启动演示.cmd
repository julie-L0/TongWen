@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (echo 请先安装 Node.js 24，然后再次启动。 & pause & exit /b 1)
if not exist "node_modules\express\package.json" call npm install --omit=dev --ignore-scripts --no-audit --no-fund
if errorlevel 1 (echo 依赖安装失败，请核对网络。 & pause & exit /b 1)
node scripts/start-demo.mjs --open
pause
