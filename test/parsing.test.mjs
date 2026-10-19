/**
 * Message-shape tests for the QQ bridge.
 *
 * These cover the two report formats NapCat can be configured with. The
 * `messagePostFormat: "string"` case is the one that matters: configured that
 * way, every message arrives as a raw CQ-code string, and a bridge that only
 * understood segment arrays would both leak `[CQ:...]` noise into the prompt
 * and never match an @ — silently ignoring every group message.
 *
 * Run: node test/parsing.test.mjs
 */
import assert from 'node:assert/strict'
import { mediaRefOf, mentionsSelf, renderMessage, safeFileName, segmentsOf } from '../index.js'

const SELF = '90001'
let passed = 0

function check(name, fn) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

/* --------------------------------------------------------- array format */

check('array: @ of the bot triggers and is dropped from the text', () => {
  const message = [
    { type: 'at', data: { qq: '90001' } },
    { type: 'text', data: { text: ' 记一下：明天十点开会' } },
  ]
  assert.equal(mentionsSelf(message, SELF), true)
  assert.equal(renderMessage(message, SELF), '记一下：明天十点开会')
})

check('array: a number qq still matches the string self id', () => {
  const message = [{ type: 'at', data: { qq: 90001 } }, { type: 'text', data: { text: 'hi' } }]
  assert.equal(mentionsSelf(message, SELF), true)
})

check('array: @ of somebody else does not trigger', () => {
  const message = [{ type: 'at', data: { qq: '10002' } }, { type: 'text', data: { text: 'hi' } }]
  assert.equal(mentionsSelf(message, SELF), false)
  assert.equal(renderMessage(message, SELF), '@10002hi')
})

check('array: @全体成员 is kept as text', () => {
  const message = [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: ' 开会' } }]
  assert.equal(mentionsSelf(message, SELF), false)
  assert.equal(renderMessage(message, SELF), '@全体成员 开会')
})

check('array: media segments become placeholders', () => {
  const message = [
    { type: 'text', data: { text: '看这个' } },
    { type: 'image', data: { file: 'a.jpg' } },
    { type: 'record', data: { file: 'a.silk' } },
    { type: 'face', data: { id: '1' } },
    { type: 'reply', data: { id: '1' } },
  ]
  assert.equal(renderMessage(message, SELF), '看这个[图片][语音][表情]')
})

/* -------------------------------------------------------- string format */

check('string: a CQ @ of the bot triggers and is dropped', () => {
  const message = '[CQ:at,qq=90001] 记一下：明天十点开会'
  assert.equal(mentionsSelf(message, SELF), true)
  assert.equal(renderMessage(message, SELF), ' 记一下：明天十点开会'.trim())
})

check('string: a CQ @ of somebody else does not trigger', () => {
  const message = '[CQ:at,qq=10002] 你好'
  assert.equal(mentionsSelf(message, SELF), false)
  assert.equal(renderMessage(message, SELF), '@10002 你好')
})

check('string: mixed CQ codes become the same text as the array form', () => {
  const message = '看这个[CQ:image,file=abc.jpg][CQ:record,file=a.silk][CQ:face,id=1]'
  assert.equal(renderMessage(message, SELF), '看这个[图片][语音][表情]')
})

check('string: plain text without CQ codes survives untouched', () => {
  assert.equal(renderMessage('大家中午吃什么', SELF), '大家中午吃什么')
  assert.equal(mentionsSelf('大家中午吃什么', SELF), false)
})

check('string: CQ escapes decode', () => {
  const message = '&#91;CQ&#93; 这样的字面量[CQ:at,qq=90001]'
  assert.equal(renderMessage(message, SELF), '[CQ] 这样的字面量')
})

check('string: a literal CQ-looking text that is not a code stays', () => {
  assert.equal(renderMessage('数组 [CQ 不是码', SELF), '数组 [CQ 不是码')
})

/* ------------------------------------------------------------- edge cases */

check('empty and malformed input never throws', () => {
  assert.equal(renderMessage('', SELF), '')
  assert.equal(renderMessage(null, SELF), '')
  assert.equal(renderMessage(undefined, SELF), '')
  assert.equal(renderMessage(42, SELF), '')
  assert.deepEqual(segmentsOf([]), [])
  assert.equal(renderMessage([{ type: 'text' }], SELF), '')
  assert.equal(mentionsSelf([{ type: 'at' }], SELF), false)
})

check('an unknown self id never matches', () => {
  assert.equal(mentionsSelf([{ type: 'at', data: { qq: '90001' } }], ''), false)
  assert.equal(mentionsSelf('[CQ:at,qq=90001]', ''), false)
})

/* ------------------------------------------------------------ media refs */

check('media: a media segment yields its reference', () => {
  assert.deepEqual(mediaRefOf({ type: 'image', data: { file: 'a.jpg', file_id: 'id1', url: 'http://x/a.jpg' } }), {
    kind: 'image',
    file: 'a.jpg',
    fileId: 'id1',
    url: 'http://x/a.jpg',
    name: '',
    size: 0,
  })
  assert.equal(mediaRefOf({ type: 'file', data: { file: 'r.pdf', file_name: 'r.pdf', file_size: 12 } }).name, 'r.pdf')
  assert.equal(mediaRefOf({ type: 'record', data: { file: 'a.silk' } }).kind, 'record')
})

check('media: segments without a usable reference are ignored', () => {
  assert.equal(mediaRefOf({ type: 'text', data: { text: 'hi' } }), null)
  assert.equal(mediaRefOf({ type: 'image', data: {} }), null)
  assert.equal(mediaRefOf({ type: 'at', data: { qq: '1' } }), null)
  assert.equal(mediaRefOf(null), null)
})

/* --------------------------------------------------------- filename safety */

check('filename: a QQ name cannot escape the folder we chose', () => {
  assert.equal(safeFileName('..\\..\\evil.exe', 'x'), 'evil.exe')
  assert.equal(safeFileName('../../etc/passwd', 'x'), 'passwd')
  assert.equal(safeFileName('C:\\Windows\\System32\\cmd.exe', 'x'), 'cmd.exe')
  assert.equal(safeFileName('/tmp/a/b.sh', 'x'), 'b.sh')
})

check('filename: empty and dot names fall back', () => {
  assert.equal(safeFileName('', 'fallback'), 'fallback')
  assert.equal(safeFileName('   ', 'fallback'), 'fallback')
  assert.equal(safeFileName('.', 'fallback'), 'fallback')
  assert.equal(safeFileName('..', 'fallback'), 'fallback')
  assert.equal(safeFileName(null, 'fallback'), 'fallback')
})

check('filename: reserved characters are replaced, ordinary names survive', () => {
  assert.equal(safeFileName('a<b>c:d"e|f?g*h.txt', 'x'), 'a_b_c_d_e_f_g_h.txt')
  assert.equal(safeFileName('会议纪要 2026-10.pdf', 'x'), '会议纪要 2026-10.pdf')
  assert.equal(safeFileName('report.pdf', 'x'), 'report.pdf')
})

check('filename: an absurdly long name is truncated, not rejected', () => {
  const name = safeFileName(`${'x'.repeat(400)}.txt`, 'fallback')
  assert.equal(name.length, 120)
})

console.log(`\n${passed} checks passed`)
