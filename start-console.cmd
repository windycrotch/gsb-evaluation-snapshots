@echo off
setlocal
pushd "%~dp0" || exit /b 1
node tools/start-console.mjs %*
set "code=%ERRORLEVEL%"
popd
exit /b %code%
