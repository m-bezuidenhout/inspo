@echo off
title Design Inspiration
cd /d "%~dp0"

echo.
echo   Starting your inspiration library...
echo.
echo   Your browser will open in a moment.
echo   KEEP THIS WINDOW OPEN while you use the site.
echo   Close it (or press Ctrl+C) when you're done.
echo.

REM Give the server a couple of seconds, then open the browser.
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://localhost:4300"

node server.js

echo.
echo   The library has stopped. You can close this window.
echo.
pause
