/**
 * 把 src/client/index.js 包装成 dsh 客户端模块格式的 lib/client.js：
 * banner 向窗口注册 factory，intro 提供 CJS 的 module/exports，
 * footer 让 factory 返回 module.exports（即插件的 { apply }）。
 * 本插件只在客户端 require('react')（平台种子词），无需其他 external。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ID = '@dsh-external/dsh-plugin-workshop'

const source = readFileSync(resolve(root, 'src/client/index.js'), 'utf8')

const bundle = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
  source,
  'return module.exports;',
  '} });',
  '',
].join('\n')

mkdirSync(resolve(root, 'lib'), { recursive: true })
writeFileSync(resolve(root, 'lib/client.js'), bundle)
console.log(`built lib/client.js (${Buffer.byteLength(bundle)} bytes)`)
