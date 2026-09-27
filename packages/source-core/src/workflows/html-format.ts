const noPrint = /(&thinsp;|&zwnj;|&zwj;|\u2009|\u200c|\u200d)/g
const blockTags = /<\/?(?:div|p|br|hr|h\d|article|dd|dl)[^>]*>/g
const comments = /<!--[^>]*-->/g
const tags = /<\/?[a-zA-Z]+(?=[ >])[^<>]*>/g

/** Mirrors Android HtmlFormatter.formatIntro for the supported string/tag cases. */
export function formatIntro(value: string): string {
  return formatText(value, tags, '')
}

function formatText(value: string, htmlTags: RegExp, paragraphIndent: string): string {
  return value
    .replaceAll('\\r\\n', '\n')
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\n')
    .replace(/(&nbsp;)+/g, ' ')
    .replace(/(&ensp;|&emsp;)/g, ' ')
    .replace(noPrint, '')
    .replace(blockTags, '\n')
    .replace(comments, '')
    .replace(htmlTags, '')
    .replace(/\s*\n+\s*/g, `\n${paragraphIndent}`)
    .replace(/^[\n\s]+/g, paragraphIndent)
    .replace(/[\n\s]+$/g, '')
}

/** Android preserves these detail-intro directives for downstream rendering. */
export function formatDetailIntro(value: string): string {
  const trimmed = value.trimStart()
  return /^<(?:usehtml|md|useweb)>/.test(trimmed) ? trimmed : formatIntro(value)
}

// HTML 4.01 named character references, matching StringEscapeUtils.unescapeHtml4.
const html4EntityData = [
  'AElig=c6 Aacute=c1 Acirc=c2 Agrave=c0 Alpha=391 Aring=c5 Atilde=c3 Auml=c4 Beta=392 Ccedil=c7 Chi=3a7',
  'Dagger=2021 Delta=394 ETH=d0 Eacute=c9 Ecirc=ca Egrave=c8 Epsilon=395 Eta=397 Euml=cb Gamma=393 Iacute=cd',
  'Icirc=ce Igrave=cc Iota=399 Iuml=cf Kappa=39a Lambda=39b Mu=39c Ntilde=d1 Nu=39d OElig=152 Oacute=d3 Ocirc=d4',
  'Ograve=d2 Omega=3a9 Omicron=39f Oslash=d8 Otilde=d5 Ouml=d6 Phi=3a6 Pi=3a0 Prime=2033 Psi=3a8 Rho=3a1 Scaron=160',
  'Sigma=3a3 THORN=de Tau=3a4 Theta=398 Uacute=da Ucirc=db Ugrave=d9 Upsilon=3a5 Uuml=dc Xi=39e Yacute=dd Yuml=178',
  'Zeta=396 aacute=e1 acirc=e2 acute=b4 aelig=e6 agrave=e0 alefsym=2135 alpha=3b1 amp=26 and=2227 ang=2220 aring=e5',
  'asymp=2248 atilde=e3 auml=e4 bdquo=201e beta=3b2 brvbar=a6 bull=2022 cap=2229 ccedil=e7 cedil=b8 cent=a2 chi=3c7',
  'circ=2c6 clubs=2663 cong=2245 copy=a9 crarr=21b5 cup=222a curren=a4 dArr=21d3 dagger=2020 darr=2193 deg=b0',
  'delta=3b4 diams=2666 divide=f7 eacute=e9 ecirc=ea egrave=e8 empty=2205 emsp=2003 ensp=2002 epsilon=3b5',
  'equiv=2261 eta=3b7 eth=f0 euml=eb euro=20ac exist=2203 fnof=192 forall=2200 frac12=bd frac14=bc frac34=be',
  'frasl=2044 gamma=3b3 ge=2265 gt=3e hArr=21d4 harr=2194 hearts=2665 hellip=2026 iacute=ed icirc=ee iexcl=a1',
  'igrave=ec image=2111 infin=221e int=222b iota=3b9 iquest=bf isin=2208 iuml=ef kappa=3ba lArr=21d0 lambda=3bb',
  'lang=2329 laquo=ab larr=2190 lceil=2308 ldquo=201c le=2264 lfloor=230a lowast=2217 loz=25ca lrm=200e lsaquo=2039',
  'lsquo=2018 lt=3c macr=af mdash=2014 micro=b5 middot=b7 minus=2212 mu=3bc nabla=2207 nbsp=a0 ndash=2013 ne=2260',
  'ni=220b not=ac notin=2209 nsub=2284 ntilde=f1 nu=3bd oacute=f3 ocirc=f4 oelig=153 ograve=f2 oline=203e omega=3c9',
  'omicron=3bf oplus=2295 or=2228 ordf=aa ordm=ba oslash=f8 otilde=f5 otimes=2297 ouml=f6 para=b6 part=2202',
  'permil=2030 perp=22a5 phi=3c6 pi=3c0 piv=3d6 plusmn=b1 pound=a3 prime=2032 prod=220f prop=221d psi=3c8 quot=22',
  'rArr=21d2 radic=221a rang=232a raquo=bb rarr=2192 rceil=2309 rdquo=201d real=211c reg=ae rfloor=230b rho=3c1',
  'rlm=200f rsaquo=203a rsquo=2019 sbquo=201a scaron=161 sdot=22c5 sect=a7 shy=ad sigma=3c3 sigmaf=3c2 sim=223c',
  'spades=2660 sub=2282 sube=2286 sum=2211 sup=2283 sup1=b9 sup2=b2 sup3=b3 supe=2287 szlig=df tau=3c4 there4=2234',
  'theta=3b8 thetasym=3d1 thinsp=2009 thorn=fe tilde=2dc times=d7 trade=2122 uArr=21d1 uacute=fa uarr=2191 ucirc=fb',
  'ugrave=f9 uml=a8 upsih=3d2 upsilon=3c5 uuml=fc weierp=2118 xi=3be yacute=fd yen=a5 yuml=ff zeta=3b6 zwj=200d',
  'zwnj=200c',
].join(' ')

const html4EntityCodepoints = new Map(
  html4EntityData.split(' ').map((entry) => {
    const separator = entry.indexOf('=')
    return [entry.slice(0, separator), Number.parseInt(entry.slice(separator + 1), 16)] as const
  }),
)

/** Decode HTML 4 named and numeric references without a DOM or platform dependency. */
export function unescapeHtml4(value: string): string {
  return value.replace(/&(#(?:[xX][\da-fA-F]+|\d+);?|[A-Za-z][A-Za-z\d]+;)/g, (entity, reference: string) => {
    if (reference.startsWith('#')) {
      const hex = /^#x/i.test(reference)
      const numeric = reference.slice(hex ? 2 : 1).replace(/;$/, '')
      const codepoint = Number.parseInt(numeric, hex ? 16 : 10)
      if (!Number.isInteger(codepoint) || codepoint < 0 || codepoint > 0x10ffff || codepoint >= 0xd800 && codepoint <= 0xdfff) return entity
      return String.fromCodePoint(codepoint)
    }
    const codepoint = html4EntityCodepoints.get(reference.slice(0, -1))
    return codepoint === undefined ? entity : String.fromCodePoint(codepoint)
  })
}

const nonImageTags = /<\/?(?!img)[a-zA-Z]+(?=[ >])[^<>]*>/g
const bodyImagePattern = /<img[^>]*\ssrc\s*=\s*['"]([^'"{>]*\{(?:[^{}]|\{[^}>]+\})+\})['"][^>]*>|<img[^>]*\sdata-(?:src|original|srcset)\s*=\s*['"]([^'">]+)['"][^>]*>|<img[^>]*\ssrc\s*=\s*"([^">]+)"[^>]*>|<img[^>]*\s(?:data-[^=>]*|src)=\s*['"]([^'">]*)['"][^>]*>/gi
const useHtmlPattern = /<usehtml>[\s\S]*?<\/usehtml>/g

export interface FormattedChapterBody {
  content: string
  imageUrls: string[]
}

/**
 * Mirrors Android HtmlFormatter.formatKeepImg and BookContent.analyzeContent:
 * protect optional usehtml spans, format text and images, decode HTML4 entities,
 * then restore the protected spans.
 */
export function formatChapterBody(
  value: string,
  responseUrl: string,
  options: { adaptSpecialStyle?: boolean } = {},
): FormattedChapterBody {
  const protectedHtml: string[] = []
  const protectedValue = options.adaptSpecialStyle === false
    ? value
    : value.replace(useHtmlPattern, (match) => {
        const placeholder = `{usehtml_${protectedHtml.length}}`
        protectedHtml.push(match)
        return placeholder
      })

  const formatted = formatKeepImg(protectedValue, responseUrl)
  const content = unescapeHtml4(formatted.content).replace(/\{usehtml_(\d+)\}/g, (placeholder, index: string) => protectedHtml[Number(index)] ?? placeholder)
  return { content, imageUrls: formatted.imageUrls.map(unescapeHtml4) }
}

function formatKeepImg(value: string, responseUrl: string): FormattedChapterBody {
  const formatted = formatText(value, nonImageTags, '　　')
  let output = ''
  let appendFrom = 0
  const imageUrls: string[] = []
  for (const match of formatted.matchAll(bodyImagePattern)) {
    const index = match.index
    if (index === undefined) continue
    const full = match[0]
    const imageValue = match[1] ?? match[2] ?? match[3] ?? match[4] ?? ''
    const imageUrl = resolveImageReference(imageValue, responseUrl)
    output += formatted.slice(appendFrom, index)
    output += `<img src="${imageUrl}">`
    if (imageUrl.length > 0) imageUrls.push(imageUrl)
    appendFrom = index + full.length
  }
  output += formatted.slice(appendFrom)
  return { content: output, imageUrls }
}

function resolveImageReference(value: string, responseUrl: string): string {
  const optionSuffix = /\s*,\s*(?=\{)/.exec(value)
  const address = optionSuffix === null ? value : value.slice(0, optionSuffix.index).trimEnd()
  const options = optionSuffix === null ? '' : `,${value.slice(optionSuffix.index + optionSuffix[0].length)}`
  const relativePath = address.trim()
  if (relativePath.startsWith('javascript')) return options
  if (/^https?:\/\//i.test(relativePath) || /^data:.*?;base64,/i.test(relativePath)) return relativePath + options
  let resolved = relativePath
  if (relativePath.length > 0) {
    try {
      let spaceToken = 'legadoImageSpaceToken'
      while (relativePath.includes(spaceToken)) spaceToken += 'x'
      resolved = new URL(relativePath.replaceAll(' ', spaceToken), responseUrl).toString().replaceAll(spaceToken, ' ')
    } catch {
      // Android retains malformed image references rather than dropping the image tag.
    }
  }
  return resolved + options
}
