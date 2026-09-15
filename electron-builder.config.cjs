'use strict'

const ossUpdateBaseUrl = (process.env.DST_UPDATE_BASE_URL || '').trim().replace(/\/+$/, '')

if (ossUpdateBaseUrl && !/^https:\/\//.test(ossUpdateBaseUrl)) {
  throw new Error('DST_UPDATE_BASE_URL must be an https:// URL')
}

const publish = ossUpdateBaseUrl
  ? [
      {
        provider: 'generic',
        url: ossUpdateBaseUrl,
        channel: 'latest'
      }
    ]
  : [
      {
        provider: 'github',
        owner: 'songyutaolong',
        repo: 'dst-adapter',
        releaseType: 'release'
      }
    ]

module.exports = {
  appId: 'com.dasuantou.adapter',
  productName: '大算头适配器',
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
    artifactName: '${name}-setup-${version}.${ext}',
    oneClick: false,
    allowToChangeInstallationDirectory: true
  },
  portable: {
    artifactName: '${name}-${version}-portable.${ext}'
  },
  protocols: [
    {
      name: '大算头适配器',
      schemes: ['dstadapter']
    }
  ],
  publish
}
