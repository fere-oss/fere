const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { exec } = require('child_process');

// Keep a global reference of the window object
let mainWindow;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load the app
  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../build/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// IPC handlers for system monitoring
ipcMain.handle('get-processes', async () => {
  return new Promise((resolve, reject) => {
    // Get running processes with their ports
    exec('ps aux', (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
});

ipcMain.handle('get-ports', async () => {
  return new Promise((resolve, reject) => {
    // Get listening ports using lsof
    exec('lsof -iTCP -sTCP:LISTEN -P -n', (error, stdout) => {
      if (error && error.code !== 1) {
        reject(error);
        return;
      }
      resolve(stdout || '');
    });
  });
});

ipcMain.handle('get-connections', async () => {
  return new Promise((resolve, reject) => {
    // Get established connections
    exec('lsof -iTCP -sTCP:ESTABLISHED -P -n', (error, stdout) => {
      if (error && error.code !== 1) {
        reject(error);
        return;
      }
      resolve(stdout || '');
    });
  });
});

ipcMain.handle('kill-process', async (event, pid) => {
  return new Promise((resolve, reject) => {
    exec(`kill ${pid}`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(true);
    });
  });
});
