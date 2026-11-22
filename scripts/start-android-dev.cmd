@echo off
rem Media Trove - Android dev server launcher
rem Double-click this file to start the HMR dev session.
rem Closing this window stops the dev server.

cd /d D:\mediatrove

set "JAVA_HOME=D:\ANDROID STUDIO\jbr"
set "ANDROID_HOME=C:\Users\MSI\AppData\Local\Android\Sdk"
set "ANDROID_SDK_ROOT=C:\Users\MSI\AppData\Local\Android\Sdk"
set "NDK_HOME=C:\Users\MSI\AppData\Local\Android\Sdk\ndk\29.0.14206865"
set "CARGO_HOME=D:\cargo"
set "GRADLE_USER_HOME=D:\gradle-home"

title Media Trove - Android Dev
echo === Media Trove Android dev server ===
echo Tablet/phone with the dev build will hot-reload from this machine.
echo Keep this window open. Closing it stops the dev server.
echo.

npm run tauri android dev

echo.
echo Dev server exited.
pause
