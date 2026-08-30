@echo off
title 3AP Production API
cd /d "%~dp0"
echo Starting 3AP Production API...
node apps/api/dist/main.js
pause
