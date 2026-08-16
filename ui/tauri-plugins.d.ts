/**
 * Shim declarations for optional Tauri plugins.
 * These are included at build time but may not be installed locally
 * in the monorepo; the declarations keep `tsc --noEmit` clean.
 */

declare module '@tauri-apps/plugin-updater' {
  export interface UpdateInfo {
    version: string
    body?: string
    date?: string
    downloadAndInstall(progress?: (event: any) => void): Promise<void>
  }
  export function check(): Promise<UpdateInfo | null>
}
