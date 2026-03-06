@echo off
echo Starting SwitchMote Local Server...
echo.

:: Check for Python
python --version >nul 2>&1
if %errorlevel% equ 0 (
    echo.
    echo [SUCCESS] Python found. Starting server...
    echo.
    echo Open your browser to: http://localhost:8000
    echo (Do NOT use https://)
    echo.
    echo Keep this window OPEN to keep the server running.
    echo.
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
