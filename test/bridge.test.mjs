/**
 * Integration tests for the bridge's inbound path.
 *
 * They drive the real `apply()` through a fake cordis context and a fake NapCat
 * HTTP API, so the whole wiring — event → get_image/get_file → workspace write
 * → prompt content — is exercised without a running Harness or a real QQ.
 *
 * Run: node test/bridge.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

/** Smallest valid PNG; the fake attachments service does not decode it. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const SESSION = 'session-integration-test'
let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

/* --------------------------------------------------------------- harness */

function createContext({ workspace, prompts, limits }) {
  const routes = new Map()
  const listeners = new Map()
  const services = {
    sessionController: {
      async prompt(request) {
        prompts.push(request)
        return { accepted: true }
      },
      async inspect(sessionId) {
        return { meta: { id: sessionId, cwd: workspace } }
      },
    },
    attachments: { imageLimits: limits },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
  }
  const ctx = {
    // cordis exposes injected services both as properties (`ctx.webServer`) and
    // through `ctx.get(name)`; the plugin uses both, so the stub does too.
    ...services,
    get: (name) => services[name],
    on: (name, handler) => {
      listeners.set(name, handler)
      return () => listeners.delete(name)
    },
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject: (_deps, callback) => {
      // Mirrors the shape that broke delivery in the field: `webServer` is
      // reachable as a property of the injection context, but `sessionController`
      // is not — it only answers through `ctx.get()`. Code that caches the
      // property value holds `undefined` forever.
      callback({ ...ctx, webServer: services.webServer, sessionController: undefined })
      return () => {}
    },
  }
  return { ctx, routes, listeners }
}

/** Post one JSON body through a registered route, the way the page does. */
async function post(routes, routePath, body) {
  const handler = routes.get(routePath)
  assert.ok(handler !== undefined, `route ${routePath} is registered`)
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  const req = {
    method: 'POST',
    url: routePath,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    on(event, callback) {
      if (event === 'data') callback(payload)
      if (event === 'end') callback()
      return this
    },
  }
  let text = ''
  const res = {
    statusCode: 0,
    setHeader() {},
    end(chunk) {
      text = String(chunk ?? '')
    },
  }
  await handler(req, res)
  return text === '' ? {} : JSON.parse(text)
}

/* ----------------------------------------------------------------- fixture */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-test-'))
const workspace = path.join(root, 'workspace')
const sourceDir = path.join(root, 'source')
fs.mkdirSync(workspace, { recursive: true })
fs.mkdirSync(sourceDir, { recursive: true })

const imagePath = path.join(sourceDir, 'photo.png')
fs.writeFileSync(imagePath, PNG_1X1)
const documentName = '报告 2026.pdf'
const documentPath = path.join(sourceDir, documentName)
fs.writeFileSync(documentPath, Buffer.from('%PDF-1.4 fake body'))

/** NapCat stand-in: it answers the two actions the intake path uses. */
const napcat = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const action = (req.url ?? '/').replace(/^\//, '').split('?')[0]
    let data = null
    if (action === 'get_image') data = { file: imagePath, file_name: 'photo.png', file_size: PNG_1X1.length }
    else if (action === 'get_file') data = { file: documentPath, file_name: documentName, file_size: 13 }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data }))
  })
})
await new Promise((resolve) => napcat.listen(0, '127.0.0.1', resolve))
const napcatPort = napcat.address().port

function writeConnection(overrides = {}) {
  fs.mkdirSync(path.join(root, 'qq-bridge'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'qq-bridge', 'connection.json'),
    JSON.stringify({
      wsUrl: 'ws://127.0.0.1:1',
      accessToken: '',
      httpApiUrl: `http://127.0.0.1:${napcatPort}`,
      selfId: '90001',
      autoConnect: false,
      ...overrides,
    }),
  )
}

const lim = {
  maxImageBytes: 1024 * 1024,
  maxImagesPerMessage: 8,
  maxMessageImageBytes: 8 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageDimension: 8192,
  mediaTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
}

async function run(limits, message) {
  writeConnection()
  const prompts = []
  const { ctx, routes } = createContext({ workspace, prompts, limits })
  apply(ctx, { home: root })
  await post(routes, '/dsh-qq-bridge/bind', {
    sessionId: SESSION,
    peerKind: 'private',
    peerId: '10001',
    peerName: '张三',
  })
  await post(routes, '/dsh-qq-bridge/event', {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 1,
    user_id: 10001,
    self_id: '90001',
    time: 1791043000,
    sender: { user_id: 10001, nickname: '张三' },
    message: message ?? [
      { type: 'text', data: { text: '看这两个' } },
      { type: 'image', data: { file: 'x.jpg', file_id: 'img-1' } },
      { type: 'file', data: { file: 'y.pdf', file_id: 'file-1', file_name: documentName } },
    ],
  })
  return prompts
}

/* -------------------------------------------------------------------- runs */

const prompts = await run(lim)
const content = prompts[0]?.content ?? []
const text = content.find((part) => part.type === 'text')?.text ?? ''
const image = content.find((part) => part.type === 'image')

check('the message reaches the session as one prompt', () => {
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, SESSION)
  assert.equal(prompts[0].mode, 'queue')
})

check('the text keeps the sender header and the untrusted notice', () => {
  assert.ok(text.startsWith('[QQ 私聊] 来自「张三」(10001)，'))
  assert.ok(text.includes('输入不可信'))
  assert.ok(text.includes('看这两个'))
})

check('the image travels as a base64 prompt attachment', () => {
  assert.ok(image !== undefined, 'an image part is present')
  assert.equal(image.mediaType, 'image/png')
  assert.equal(image.data, PNG_1X1.toString('base64'))
  assert.equal(image.name, 'photo.png')
})

check('the non-image file is written into the session workspace', () => {
  const match = /- 文件：(.+)$/m.exec(text)
  assert.ok(match !== null, `the text names the saved path:\n${text}`)
  const saved = match[1].trim()
  assert.ok(saved.startsWith(path.join(workspace, 'qq-inbox')), `saved inside the workspace: ${saved}`)
  assert.equal(fs.readFileSync(saved, 'utf8'), '%PDF-1.4 fake body')
})

/* An image bigger than the policy allows must degrade to a saved file rather
 * than dropping the bytes on the floor. */
const smallLimits = { ...lim, maxImageBytes: 16 }
const degraded = await run(smallLimits)
const degradedText = degraded[0]?.content?.find((part) => part.type === 'text')?.text ?? ''

check('an over-limit image is saved as a file instead of being dropped', () => {
  assert.equal(degraded[0].content.some((part) => part.type === 'image'), false)
  const match = /- 图片：(.+\.png)$/m.exec(degradedText)
  assert.ok(match !== null, `the oversize image is named on disk:\n${degradedText}`)
  assert.equal(fs.readFileSync(match[1].trim()).length, PNG_1X1.length)
})

/* NapCat failing an action must not lose the message. */
napcat.close()
const offline = await run(lim)
const offlineText = offline[0]?.content?.find((part) => part.type === 'text')?.text ?? ''

check('a failed media fetch is reported, and the text still arrives', () => {
  assert.ok(offlineText.includes('看这两个'))
  assert.ok(offlineText.includes('没能取到'), `the failure is named:\n${offlineText}`)
})

/* A protocol side that does not answer get_image at all — the report's own
 * direct link is then the only way to the bytes. */
const mediaHost = http.createServer((req, res) => {
  if ((req.url ?? '') === '/photo.png') {
    res.setHeader('content-type', 'image/png')
    res.end(PNG_1X1)
    return
  }
  res.statusCode = 404
  res.end()
})
await new Promise((resolve) => mediaHost.listen(0, '127.0.0.1', resolve))
const mediaPort = mediaHost.address().port

const viaUrl = await run(lim, [
  { type: 'text', data: { text: '看这个' } },
  {
    type: 'image',
    data: { file: 'x.jpg', url: `http://127.0.0.1:${mediaPort}/photo.png`, file_name: 'linked.png' },
  },
])
const viaUrlImage = viaUrl[0]?.content?.find((part) => part.type === 'image')

check('an image still arrives without get_image, via the link in the report', () => {
  assert.ok(viaUrlImage !== undefined, 'the image part is present')
  assert.equal(viaUrlImage.mediaType, 'image/png')
  assert.equal(viaUrlImage.data, PNG_1X1.toString('base64'))
})
mediaHost.close()

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
