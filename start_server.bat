@echo off
echo Starting SwitchMote Local Server...
echo.

:: Check for Python
python --version >nul 2>&1
if %errorlevel% equ 0 (
    echo Python found. Starting server on port 8000...
    start http://localhost:8000
    python -m http.server 8000
    goto end
)

:: Check for Node.js (http-server)
timeout /t 1 >nul
echo Python not found. Checking for Node.js...
node --version >nul 2>&1
if %errorlevel% equ 0 (
    echo Node.js found. Using npx http-server...
    start http://localhost:8080
    call npx http-server -p 8080 -c-1
    goto end
)

:error
echo.
echo [ERROR] Neither Python nor Node.js could be found.
echo Please install Python (python.org) or Node.js (nodejs.org) to run this local server.
echo.
pause

:end
