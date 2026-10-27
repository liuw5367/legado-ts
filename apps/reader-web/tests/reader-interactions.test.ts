import assert from 'node:assert/strict'
import test from 'node:test'
import { cancelReaderGesture, chapterCharacterCount, finishReaderGesture, isCurrentToc, isReaderTap, moveReaderGesture, startReaderGesture } from '../src/lib/reader-interactions.ts'
import { pageReturnTarget } from '../src/lib/page-navigation.ts'
import { clampPageIndex, pageActionForTap, pageCountFromScrollWidth, pageLabel } from '../src/lib/reader-pagination.ts'

test('chapter count excludes whitespace and counts Unicode code points', () => {
  assert.equal(chapterCharacterCount('甲乙\n 丙。 A1 😀\u3000'), 7)
  assert.equal(chapterCharacterCount(' \t\n'), 0)
})
test('reader taps exclude scrolling, dragging and selecting text', () => {
  const start = { x: 50, y: 60, scrollY: 300 }
  assert.equal(isReaderTap(start, { ...start, x: 52 }, ''), true)
  assert.equal(isReaderTap(start, { ...start, x: 90 }, ''), false)
  assert.equal(isReaderTap(start, { ...start, scrollY: 310 }, ''), false)
  assert.equal(isReaderTap(start, start, '选中文字'), false)
})
test('pagination helpers calculate stable page counts and boundaries', () => {
  assert.equal(pageCountFromScrollWidth(1000, 400), 3)
  assert.equal(pageCountFromScrollWidth(400, 400), 1)
  assert.equal(pageCountFromScrollWidth(0, 400), 0)
  assert.equal(clampPageIndex(-1, 3), 0)
  assert.equal(clampPageIndex(9, 3), 2)
  assert.equal(pageLabel(1, 3), '2/3')
})
test('paginated reader taps map to previous, controls, and next actions', () => {
  const point = { x: 100, y: 80, scrollY: 0 }
  assert.equal(pageActionForTap(point, point, '', 99, 0, 300), 'previous')
  assert.equal(pageActionForTap(point, point, '', 150, 0, 300), 'toggle-controls')
  assert.equal(pageActionForTap(point, point, '', 250, 0, 300), 'next')
  assert.equal(pageActionForTap(point, { ...point, x: 120 }, '', 250, 0, 300), null)
})
test('TOC responses from another book or source are not current', () => {
  const toc = { bookId: 'book-a', editionKey: 'source-a' }
  assert.equal(isCurrentToc(toc, 'book-a', 'source-a'), true)
  assert.equal(isCurrentToc(toc, 'book-a', 'source-b'), false)
  assert.equal(isCurrentToc(toc, 'book-b', 'source-a'), false)
  assert.equal(isCurrentToc(null, 'book-a', 'source-a'), false)
})
test('page return preserves parent state and rejects external/self targets', () => {
  assert.deepEqual(pageReturnTarget({ backTo: '/search?q=书', backState: { backTo: '/' } }, '/books/b/toc', '/'), { to: '/search?q=书', state: { backTo: '/' } })
  for (const backTo of ['//evil.example', '/\\evil.example', 'https://evil.example', '/books/b/toc?editionKey=old', '/\nmalformed']) assert.equal(pageReturnTarget({ backTo }, '/books/b/toc', '/').to, '/')
})

test('paginated taps resume immediately after an existing text selection', () => {
  const start = { x: 250, y: 80, scrollY: 0, selectedText: '原有选区' }
  assert.equal(isReaderTap(start, start, '原有选区'), true)
  assert.equal(pageActionForTap(start, start, '原有选区', 250, 0, 300), 'next')
  assert.equal(pageActionForTap(start, { ...start, x: 50 }, '原有选区', 50, 0, 300), null)
  const previous = { ...start, x: 50 }
  assert.equal(pageActionForTap(previous, previous, '原有选区', 50, 0, 300), 'previous')
  assert.equal(pageActionForTap(start, start, '重新选择的文字', 250, 0, 300), null)
  assert.equal(pageActionForTap({ ...start, selectedText: '' }, start, '新选区', 250, 0, 300), null)
  assert.equal(isReaderTap(null, start, '原有选区'), false)
})

function swipe(x: number, time: number, width = 390, y = 0) {
  const gesture = startReaderGesture({ x: 100, y: 100, time: 0 }, width, true)
  moveReaderGesture(gesture, { x: 100 + Math.sign(x) * 15, y: 100, time: 30 })
  return { gesture, action: finishReaderGesture(gesture, { x: 100 + x, y: 100 + y, time }) }
}

test('reader swipes combine distance, speed, direction and duration', () => {
  assert.equal(swipe(-50, 400).action, 'next')
  assert.equal(swipe(50, 400).action, 'previous')
  assert.equal(swipe(-30, 80).action, 'next')
  assert.equal(swipe(-30, 200).action, null)
  assert.equal(swipe(-50, 800).action, 'next')
  assert.equal(swipe(-50, 801).action, null)
  assert.equal(swipe(-105, 300, 1024).action, 'next')
  assert.equal(swipe(-28, 80).action, 'next')
  assert.equal(swipe(-27.9, 70).action, null)
  assert.equal(swipe(-28, 81).action, null)
  assert.equal(swipe(-50, 0).action, null)
  assert.equal(swipe(-50, 400, 390, 30).action, 'next')
  assert.equal(swipe(-50, 400, 390, 40).action, null)
  for (const [width, threshold] of [[320, 40], [390, 46.8], [1024, 72]] as const) {
    assert.equal(swipe(-threshold, 400, width).action, 'next')
    assert.equal(swipe(-(threshold - 0.01), 400, width).action, null)
  }
})

test('reader gesture rejects vertical starts, retraction and long presses', () => {
  const start = { x: 100, y: 100, time: 0 }
  const vertical = startReaderGesture(start, 390, true)
  moveReaderGesture(vertical, { x: 102, y: 120, time: 30 })
  assert.equal(finishReaderGesture(vertical, { x: 0, y: 120, time: 200 }), null)
  for (const [retraction, action] of [[20, 'next'], [20.1, null]] as const) {
    const gesture = startReaderGesture(start, 390, true)
    moveReaderGesture(gesture, { x: 20, y: 100, time: 100 })
    assert.equal(finishReaderGesture(gesture, { x: 20 + retraction, y: 100, time: 400 }), action)
  }
  const held = startReaderGesture(start, 390, true)
  moveReaderGesture(held, { ...start, time: 300 })
  assert.equal(finishReaderGesture(held, { x: 0, y: 100, time: 450 }), null)
  assert.equal(swipe(-50, 400).action, 'next')
})

test('reader drag and cancellation block the associated click without blocking a new gesture', () => {
  const start = { x: 100, y: 100, time: 0 }
  const tap = startReaderGesture(start, 390, true)
  moveReaderGesture(tap, { ...start, x: 107.9, time: 50 })
  assert.equal(tap.clickBlocked, false)
  moveReaderGesture(tap, { ...start, x: 108, time: 60 })
  finishReaderGesture(tap, { ...start, time: 100 })
  assert.equal(tap.clickBlocked, true)
  const cancelled = startReaderGesture(start, 390, true)
  cancelReaderGesture(cancelled)
  assert.equal(finishReaderGesture(cancelled, { x: 0, y: 100, time: 100 }), null)
  assert.equal(cancelled.clickBlocked, true)
  const selectionOrEdge = startReaderGesture(start, 390, false)
  assert.equal(finishReaderGesture(selectionOrEdge, { ...start, time: 100 }), null)
  assert.equal(selectionOrEdge.clickBlocked, false)
  assert.equal(startReaderGesture(start, 390, true).clickBlocked, false)
  assert.equal(swipe(-50, 400).gesture.clickBlocked, true)
})

test('reader gesture direction and cancellation remain stable throughout a trajectory', () => {
  const start = { x: 100, y: 100, time: 0 }
  const diagonal = startReaderGesture(start, 390, true)
  moveReaderGesture(diagonal, { x: 115, y: 115, time: 40 })
  assert.equal(finishReaderGesture(diagonal, { x: 125, y: 125, time: 100 }), null)
  const turnedBack = startReaderGesture(start, 390, true)
  moveReaderGesture(turnedBack, { x: 20, y: 100, time: 100 })
  moveReaderGesture(turnedBack, { x: 50, y: 100, time: 150 })
  assert.equal(finishReaderGesture(turnedBack, { x: 0, y: 100, time: 250 }), null)
  const held = startReaderGesture(start, 390, true)
  moveReaderGesture(held, { ...start, x: 105, time: 299 })
  moveReaderGesture(held, { ...start, x: 110, time: 300 })
  assert.equal(finishReaderGesture(held, { x: 0, y: 100, time: 400 }), null)
  const cancelledAtEnd = startReaderGesture(start, 390, true)
  moveReaderGesture(cancelledAtEnd, { x: 0, y: 100, time: 100 })
  cancelReaderGesture(cancelledAtEnd)
  assert.equal(finishReaderGesture(cancelledAtEnd, { x: 0, y: 100, time: 120 }), null)
  assert.equal(cancelledAtEnd.clickBlocked, true)
})


test('stationary long press blocks the release click before native selection arrives', () => {
  const start = { x: 100, y: 100, time: 0 }
  const tap = startReaderGesture(start, 390, true)
  finishReaderGesture(tap, { ...start, time: 299 })
  assert.equal(tap.clickBlocked, false)
  for (const allowed of [true, false]) {
    const held = startReaderGesture(start, 390, allowed)
    assert.equal(finishReaderGesture(held, { ...start, time: 600 }), null)
    assert.equal(held.clickBlocked, true)
  }
})
