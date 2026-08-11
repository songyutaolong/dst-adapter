import type { DstApi } from './index'

declare global {
  interface Window {
    dst: DstApi
  }
}

export {}
