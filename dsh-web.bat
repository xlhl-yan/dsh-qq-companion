@echo off
setlocal
title DSH Web

rem ============================================================
rem  dsh-web.bat —— 启动前先等旧的 DSH 真的退干净
rem
rem  为什么需要它：Ctrl+C 之后 cmd 马上就把提示符还给你了，但 Node 进程
rem  还在跑 dispose()（关端口、断 WS、写会话日志）。这几秒里再敲 dsh web，
rem  新进程会跟旧进程抢 3080 / 8326 端口 —— 抢输的那个模型网关起不来，
rem  于是模型为空、{{model}} 取不到值、第一轮直接报错。
rem
rem  这个脚本会等到两个端口都没人监听再启动。
rem ============================================================

set DSH_PORT=3080
set GATEWAY_PORT=8326

:wait
set BUSY=0

netstat -ano | findstr ":%DSH_PORT% " | findstr /I "LISTENING" >nul 2>&1
if %errorlevel%==0 set BUSY=1

netstat -ano | findstr ":%GATEWAY_PORT% " | findstr /I "LISTENING" >nul 2>&1
if %errorlevel%==0 set BUSY=1

if %BUSY%==1 (
  echo 旧的 DSH 还在退出中，等待端口释放...
  timeout /t 2 /nobreak >nul
  goto wait
)

echo 端口已释放，启动 DSH...
echo.
echo   ============================================
echo    退出请按 Ctrl+C（不要点窗口右上角的 x）
echo   ============================================
echo.

dsh web

rem 走到这里说明 DSH 进程真的结束了（Ctrl+C 触发了优雅退出）
echo.
echo DSH 已退出。
echo.
echo 如果刚才按的是 Ctrl+C，下面这行应该已经没有输出了：
netstat -ano | findstr ":%DSH_PORT% " | findstr /I "LISTENING"
echo.
pause
