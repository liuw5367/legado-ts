const noPrint = /(&thinsp;|&zwnj;|&zwj;|\u2009|\u200c|\u200d)/g
const blockTags = /<\/?(?:div|p|br|hr|h\d|article|dd|dl)[^>]*>/g
const comments = /<!--[\s\S]*?-->/g
const tags = /<\/?[a-zA-Z]+(?=[ >])[^<>]*>/g

/** Mirrors Android HtmlFormatter.formatIntro for the supported string/tag cases. */
export function formatIntro(value: string): string {
  return value
    .replaceAll('\\r\\n', '\n')
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\n')
    .replace(/(&nbsp;)+/g, ' ')
    .replace(/(&ensp;|&emsp;)/g, ' ')
    .replace(noPrint, '')
    .replace(blockTags, '\n')
    .replace(comments, '')
    .replace(tags, '')
    .replace(/\s*\n+\s*/g, '\n')
    .replace(/^[\n\s]+/g, '')
    .replace(/[\n\s]+$/g, '')
}

/** Android preserves these detail-intro directives for downstream rendering. */
export function formatDetailIntro(value: string): string {
  const trimmed = value.trimStart()
  return /^<(?:usehtml|md|useweb)>/.test(trimmed) ? trimmed : formatIntro(value)
}
