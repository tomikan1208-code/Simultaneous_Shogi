@echo off
setlocal
if not exist "%~dp0start-server.bat" (
  echo [ERROR] start-server.bat is missing from the game folder.
  echo Restore start-server.bat beside start-game.bat, then try again.
  pause
  exit /b 1
)
call "%~dp0start-server.bat" --open %*
exit /b %errorlevel%
