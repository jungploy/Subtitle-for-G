// electron/main.js
// 桌面程序入口：启动内嵌服务并打开原生窗口加载应用。
// 运行：npm install && npm start
'use strict';

const { app, BrowserWindow } = require('electron');
const { server, PORT } = require('./server.cjs');

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    title: 'Subtitle-for-G · 字幕双语编辑器',
    webPreferences: {
      contextIsolation: true, // 渲染进程不暴露 Node，安全
      nodeIntegration: false,
    },
  });

  win.loadURL(`http://localhost:${PORT}/`);
  // 调试时可打开开发者工具：win.webContents.openDevTools();
}

app.whenReady().then(() => {
  server.listen(PORT, () => {
    console.log(`desktop server listening on http://localhost:${PORT}`);
    createWindow();
  });
});

app.on('window-all-closed', () => {
  server.close();
  if (process.platform !== 'darwin') app.quit();
});
