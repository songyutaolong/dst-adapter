import baseConfig from './electron.vite.config'
import { mergeConfig } from 'electron-vite'

export default mergeConfig(baseConfig, {
  renderer: {
    server: {
      port: 5310,
      strictPort: true
    }
  }
})
