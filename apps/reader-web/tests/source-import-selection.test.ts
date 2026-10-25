import assert from 'node:assert/strict'
import test from 'node:test'
import { updateImportSelection } from '../src/lib/source-import-selection.ts'

test('bulk selection affects only the filtered region and preserves other selections', () => {
  const selected = ['hidden', 'other-region', 'one']
  assert.deepEqual(updateImportSelection(selected, ['one', 'two'], 'all'), ['hidden', 'other-region', 'one', 'two'])
  assert.deepEqual(updateImportSelection(selected, ['one', 'two'], 'invert'), ['hidden', 'other-region', 'two'])
  assert.deepEqual(updateImportSelection(selected, ['one', 'two'], 'clear'), ['hidden', 'other-region'])
  assert.deepEqual(selected, ['hidden', 'other-region', 'one'])
})

test('empty, repeated and inverted selections remain stable without duplicates', () => {
  assert.deepEqual(updateImportSelection(['one'], [], 'invert'), ['one'])
  assert.deepEqual(updateImportSelection(['one'], ['one', 'two'], 'all'), ['one', 'two'])
  assert.deepEqual(updateImportSelection(['one', 'two'], ['one', 'two'], 'all'), ['one', 'two'])
  const inverted = updateImportSelection(['one'], ['one', 'two', 'three'], 'invert')
  assert.deepEqual(inverted, ['two', 'three'])
  assert.deepEqual(updateImportSelection(inverted, ['one', 'two', 'three'], 'invert'), ['one'])
})
