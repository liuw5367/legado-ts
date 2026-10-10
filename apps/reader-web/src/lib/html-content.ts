const allowedTags = new Set(['a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'figure', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'i', 'img', 'li', 'ol', 'p', 'pre', 'q', 'small', 'span', 'strong', 'u', 'ul'])
const removedTags = new Set(['audio', 'embed', 'form', 'iframe', 'object', 'script', 'style', 'svg', 'video'])

export function safeResourceUrl(value: string, image = false): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  try {
    const url = new URL(trimmed, window.location.href)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString()
    if (image && url.protocol === 'data:' && /^data:image\//iu.test(trimmed)) return trimmed
  } catch {
    return undefined
  }
  return undefined
}

/** 保留书源正文的结构和图片，移除脚本、事件属性及不安全 URL。 */
export function sanitizeChapterHtml(value: string): string {
  if (typeof DOMParser === 'undefined') return escapeHtml(value)
  const document = new DOMParser().parseFromString(`<div>${value}</div>`, 'text/html')
  const root = document.body.firstElementChild
  if (root === null) return ''
  sanitizeNode(root)
  return root.innerHTML
}

function sanitizeNode(parent: Element): void {
  for (const node of [...parent.children]) {
    const tag = node.tagName.toLowerCase()
    if (removedTags.has(tag)) { node.remove(); continue }
    if (!allowedTags.has(tag)) {
      // 未知节点会被展开，但其子树仍然来自不可信正文，必须先按正常节点递归清洗。
      const holder = parent.ownerDocument.createElement('div')
      while (node.firstChild !== null) holder.append(node.firstChild)
      sanitizeNode(holder)
      const replacement = parent.ownerDocument.createDocumentFragment()
      while (holder.firstChild !== null) replacement.append(holder.firstChild)
      node.replaceWith(replacement)
      continue
    }
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || name === 'style' || !['alt', 'height', 'href', 'loading', 'rel', 'src', 'target', 'title', 'width'].includes(name)) node.removeAttribute(attribute.name)
    }
    if (tag === 'img') {
      const url = safeResourceUrl(node.getAttribute('src') ?? '', true)
      if (url === undefined) node.remove()
      else { node.setAttribute('src', url); node.setAttribute('loading', 'lazy'); node.setAttribute('decoding', 'async') }
    } else if (tag === 'a') {
      const url = safeResourceUrl(node.getAttribute('href') ?? '')
      if (url === undefined) node.removeAttribute('href')
      else { node.setAttribute('href', url); node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer') }
    }
    sanitizeNode(node)
  }
}

function escapeHtml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;') }
