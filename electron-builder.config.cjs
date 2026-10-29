'use strict'

const defaultOssUpdateBaseUrl =
  'https://dst-adapter-releases.oss-cn-shanghai.aliyuncs.com/dst-adapter/releases'
const ossUpdateBaseUrl = (process.env.DST_UPDATE_BASE_URL || defaultOssUpdateBaseUrl)
  .trim()
  .replace(/\/+$/, '')

if (ossUpdateBaseUrl && !/^https:\/\//.test(ossUpdateBaseUrl)) {
  throw new Error('DST_UPDATE_BASE_URL must be an https:// URL')
}

const publish = [
  {
    provider: 'generic',
    url: ossUpdateBaseUrl,
    channel: 'latest'
  }
]

module.exports = {
  appId: 'com.dasuantou.adapter',
  productName: 'dst Ai控制台',
  directories: {
    output: 'release'
  },
  files: ['out/**/*', 'resources/**/*'],
  extraResources: [
    {
      from: 'resources',
      to: 'resources'
    }
  ],
  win: {
    icon: 'resources/icon.ico',
    target: ['nsis', 'portable']
  },
  mac: {
    artifactName: '${name}-${version}-${arch}.${ext}',
    target: [
      {
        target: 'dmg',
        arch: ['universal']
      },
      {
        target: 'zip',
        arch: ['universal']
      }
    ],
    category: 'public.app-category.developer-tools',
    hardenedRuntime: false,
    gatekeeperAssess: false
  },
  nsis: {
    // 产物名必须纯 ASCII（^[0-9A-Za-z._-]+$），否则 electron-builder 会在
    // latest.yml 里回退成 package.json 的 name，与实际上传文件名不一致导致更新 404。
    // 品牌展示由 productName 负责（窗口标题/安装目录/快捷方式/卸载项）。
    artifactName: 'dst-setup-${version}.${ext}',
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    include: 'build/installer.nsh'
  },
  portable: {
    artifactName: 'dst-${version}-portable.${ext}'
  },
  protocols: [
    {
      name: 'dst Ai控制台',
      schemes: ['dstadapter']
    }
  ],
  publish
}
