@echo off
chcp 65001 >nul
rem ============================================================
rem  gkpv  -  single-file photo browser, served over localhost
rem
rem  Why serve over http://127.0.0.1 instead of opening the HTML
rem  file directly: a file:// page has an opaque origin, so the
rem  browser refuses OPFS storage. gkpv uses OPFS to cache
rem  thumbnails, so opening via localhost keeps that cache across
rem  sessions (much faster on folders with thousands of images).
rem
rem  The server is serve.py next to this file, started with
rem  pythonw.exe so no console window is kept open.
rem ============================================================
set "PORT=8777"
set "ROOT=F://gkpv"
set "PYW=C://Python314//pythonw.exe"

rem If the service is already up, this second instance just exits.
start "" /b "%PYW%" "%ROOT%\serve.py"

rem Give it a moment to bind, then open the browser.
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:%PORT%/gkpv.html"
exit /b 0
