// The page's only bridge to Electron: a screenshot of the window for Report a problem, and opening its folder
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('abraDesktop', {
  capture: () => ipcRenderer.invoke('abra:capture'),
  showFolder: folder => ipcRenderer.invoke('abra:show-folder', folder),
});
