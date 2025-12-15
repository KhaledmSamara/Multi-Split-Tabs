const { contextBridge, ipcRenderer } = require('electron');

try {
  contextBridge.exposeInMainWorld('electronAPI', {
    sendTabClicked: (pageId, tabIndex) => {
      try {
        ipcRenderer.send('tab-clicked', pageId, tabIndex);
      } catch (e) {}
    },
    navigateTo: (url) => {
      try {
        ipcRenderer.send('navigate-to', url);
      } catch (e) {}
    }
  });
} catch (e) {}
