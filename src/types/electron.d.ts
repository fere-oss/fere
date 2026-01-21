export interface ElectronAPI {
  getProcesses: () => Promise<string>;
  getPorts: () => Promise<string>;
  getConnections: () => Promise<string>;
  killProcess: (pid: number) => Promise<boolean>;
  platform: string;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
