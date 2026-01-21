const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// Import services
const { getDevProcesses, getAllProcesses, killProcess } = require('./services/processMonitor');
const { getListeningPorts, getEstablishedConnections } = require('./services/portMonitor');
const { buildConnectionGraph, getEnvironmentSummary } = require('./services/connectionGraph');

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
    trafficLightPosition: { x: 15, y: 15 },
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

// ============================================
// IPC Handlers - System Monitoring API
// ============================================

// Get all dev-related processes (filtered)
ipcMain.handle('get-dev-processes', async () => {
  try {
    return await getDevProcesses();
  } catch (error) {
    console.error('Error getting dev processes:', error);
    return [];
  }
});

// Get all processes (unfiltered)
ipcMain.handle('get-all-processes', async () => {
  try {
    return await getAllProcesses();
  } catch (error) {
    console.error('Error getting all processes:', error);
    return [];
  }
});

// Get listening ports
ipcMain.handle('get-listening-ports', async () => {
  try {
    return await getListeningPorts();
  } catch (error) {
    console.error('Error getting listening ports:', error);
    return [];
  }
});

// Get established connections
ipcMain.handle('get-connections', async () => {
  try {
    return await getEstablishedConnections();
  } catch (error) {
    console.error('Error getting connections:', error);
    return [];
  }
});

// Get the full connection graph (nodes + edges)
ipcMain.handle('get-connection-graph', async () => {
  try {
    return await buildConnectionGraph();
  } catch (error) {
    console.error('Error building connection graph:', error);
    return { nodes: [], edges: [] };
  }
});

// Get environment summary
ipcMain.handle('get-environment-summary', async () => {
  try {
    return await getEnvironmentSummary();
  } catch (error) {
    console.error('Error getting environment summary:', error);
    return { totalServices: 0, totalConnections: 0, services: [] };
  }
});

// Kill a process by PID
ipcMain.handle('kill-process', async (event, pid) => {
  try {
    return await killProcess(pid);
  } catch (error) {
    console.error('Error killing process:', error);
    return { success: false, error: error.message };
  }
});
