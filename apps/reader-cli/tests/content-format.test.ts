import assert from 'node:assert/strict'
import test from 'node:test'
import { formatChapterContent } from '../src/content-format.ts'

test('HTML 正文保留块级段落语义并隐藏脚本样式', () => {
  const result = formatChapterContent('<p>第一段&nbsp;内容</p><div>第二段<br>换行</div><script>恶意脚本</script><style>隐藏</style>', 'html')
  assert.match(result.text, /第一段 内容/)
  assert.match(result.text, /第二段\n换行/)
  assert.doesNotMatch(result.text, /恶意脚本|隐藏|<p>|<div>/)
  assert.equal(result.blocks.filter((block) => block.kind === 'paragraph').length, 2)
})

test('标题、引用、列表、预格式和图片占位可辨识', () => {
  const result = formatChapterContent('<h2>标题</h2><blockquote>引用</blockquote><ol><li>一</li><li>二</li></ol><pre>  code\n  next</pre><img alt="插图">', 'html')
  assert.match(result.text, /## 标题/)
  assert.match(result.text, /│ 引用/)
  assert.match(result.text, /1\. 一/)
  assert.match(result.text, /2\. 二/)
  assert.match(result.text, /  code\n  next/)
  assert.match(result.text, /\[图片：插图\]/)
})

test('纯文本输入保持空行分段', () => {
  const result = formatChapterContent('第一段\n\n第二段', 'text')
  assert.deepEqual(result.blocks.map((block) => block.text), ['第一段', '第二段'])
  assert.equal(result.text, '第一段\n\n第二段')
})

test('容器中的混合文本和嵌套列表不会吞掉块级内容', () => {
  const result = formatChapterContent('<html><body>引导语<p>第一段</p><ul><li>外层<ul><li>内层</li></ul></li></ul>结尾</body></html>', 'html')
  assert.match(result.text, /引导语/)
  assert.match(result.text, /第一段/)
  assert.match(result.text, /• 外层/)
  assert.match(result.text, /  • 内层/)
  assert.match(result.text, /结尾/)
})
