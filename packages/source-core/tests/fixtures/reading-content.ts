import type { ReadingContentInput } from '../../src/reading/content.ts'

export const readingContentCases: { name: string; input: ReadingContentInput; texts: string[]; kinds: string[] }[] = [
  { name: 'text 换行、空行和 UTF-16', input: { contentType: 'text', cleaned: '甲😀乙\r\n\r\n第二段\r第三段', resources: [] }, texts: ['甲😀乙', '第二段', '第三段'], kinds: ['paragraph', 'paragraph', 'paragraph'] },
  { name: 'HTML 嵌套容器与 br 独立断段', input: { contentType: 'html', cleaned: '<div><p>甲😀乙</p><div>第二段<br>第三段</div></div>', resources: [] }, texts: ['甲😀乙', '第二段', '第三段'], kinds: ['paragraph', 'paragraph', 'paragraph'] },
  { name: 'HTML 行内格式、实体与链接文字', input: { contentType: 'html', cleaned: '<p>甲&amp;<b>乙<em>丙</em></b><a href="javascript:evil()">丁</a></p>', resources: [] }, texts: ['甲&乙丙丁'], kinds: ['paragraph'] },
  { name: 'text 保留图片及 usehtml', input: { contentType: 'text', cleaned: '前文<img src="../a.png">后文\n<usehtml><p>特殊<b>文字</b></p><p>另一段</p></usehtml>\n尾段', baseUrl: 'https://book.test/chapter/1', resources: [{ kind: 'image', url: 'https://book.test/a.png' }] }, texts: ['前文', '', '后文', '特殊文字', '另一段', '尾段'], kinds: ['paragraph', 'image', 'paragraph', 'paragraph', 'paragraph', 'paragraph'] },
  { name: '内嵌图片顺序、重复图片与附加去重', input: { contentType: 'html', cleaned: '<p>甲<img src="/a.png">乙<img src="/a.png">丙</p>', baseUrl: 'https://book.test/1', resources: [{ kind: 'image', url: '/a.png' }, { kind: 'image', url: '/b.png' }, { kind: 'image', url: '/b.png' }] }, texts: ['甲', '', '乙', '', '丙', ''], kinds: ['paragraph', 'image', 'paragraph', 'image', 'paragraph', 'image'] },
  { name: '危险节点整棵移除，未知容器保留正文', input: { contentType: 'html', cleaned: '<p style="user-select:none">正文</p><script>危险</script><iframe>危险</iframe><svg><text>危险</text></svg><custom>保留</custom><img src="javascript:evil()"><img src="data:image/svg+xml;base64,PHN2Zz4=">', resources: [] }, texts: ['正文', '保留'], kinds: ['paragraph', 'paragraph'] },
  { name: '常见未闭合段落', input: { contentType: 'html', cleaned: '<p>第一段<p>第二段', resources: [] }, texts: ['第一段', '第二段'], kinds: ['paragraph', 'paragraph'] },
  { name: '源码排版空白、pre 和列表', input: { contentType: 'html', cleaned: '<div>\n<p>甲\n 乙</p>\n<pre>丙\n丁</pre><ul><li>戊</li><li>己</li></ul></div>', resources: [] }, texts: ['甲 乙', '丙', '丁', '戊', '己'], kinds: ['paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph'] },
  { name: '已净化的 html 换行不被合并或重复解码', input: { contentType: 'html', cleaned: '第一段\n第二段 &amp; 原样实体', resources: [] }, texts: ['第一段', '第二段 &amp; 原样实体'], kinds: ['paragraph', 'paragraph'] },
  { name: '普通 text 不重新解释标签或实体', input: { contentType: 'text', cleaned: '甲<b>乙</b>&amp;\n&lt;img src="x"&gt;', resources: [] }, texts: ['甲<b>乙</b>&amp;', '&lt;img src="x"&gt;'], kinds: ['paragraph', 'paragraph'] },
  { name: '显式分页标记不显示为文字', input: { contentType: 'text', cleaned: '[newpage]\n甲\n[newpage]\n[newpage]\n乙\n[newpage]', resources: [] }, texts: ['甲', '', '乙'], kinds: ['paragraph', 'pageBreak', 'paragraph'] },
  { name: '空 HTML', input: { contentType: 'html', cleaned: '<div><p> </p><br></div>', resources: [] }, texts: [], kinds: [] },
]
readingContentCases.push(
  { name: 'HTML 跨行内节点空白折叠', input: { contentType: 'html', cleaned: '<p>甲 <b> 乙 </b> 丙</p>', resources: [] }, texts: ['甲 乙 丙'], kinds: ['paragraph'] },
  { name: 'pre 保留行首与行尾空格', input: { contentType: 'html', cleaned: '<pre>  甲  \n    乙</pre>', resources: [] }, texts: ['  甲  ', '    乙'], kinds: ['paragraph', 'paragraph'] },
  { name: 'HTML 段落中的显式分页', input: { contentType: 'html', cleaned: '<p>甲</p><p>[newpage]</p><p>乙</p>', resources: [] }, texts: ['甲', '', '乙'], kinds: ['paragraph', 'pageBreak', 'paragraph'] },
)
readingContentCases.push(
  { name: 'text 图片属性包含大于号', input: { contentType: 'text', cleaned: '前<img alt="a > b" src="/a.png">后', baseUrl: 'https://book.test/1', resources: [] }, texts: ['前', '', '后'], kinds: ['paragraph', 'image', 'paragraph'] },
)
