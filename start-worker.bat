@echo off
title 3AP Production Worker
cd /d "%~dp0"
echo Starting 3AP Production Worker...
node apps/worker/dist/main.js
pause
