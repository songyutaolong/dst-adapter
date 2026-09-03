import type { DstApi } from '../../preload/index'

declare global {
  interface Window {
    dst: DstApi
  }
}

export {}
