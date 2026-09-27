import assert from 'node:assert/strict'
import test from 'node:test'
import * as sourceCore from '@legado/source-core'
import * as sourceNode from '@legado/source-node'

test('workspace package entries expose the built runtime APIs', () => {
  assert.equal(typeof sourceCore.searchBooks, 'function')
  assert.equal(typeof sourceCore.loadTableOfContents, 'function')
  assert.equal(typeof sourceCore.loadChapterContent, 'function')
  assert.equal(typeof sourceNode.createNodeSourceSession, 'function')
  assert.equal(typeof sourceNode.SourceRuleHost, 'function')
  assert.equal(typeof sourceNode.SourceRequestHost, 'function')
})
