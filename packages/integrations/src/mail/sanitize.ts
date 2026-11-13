import sanitizeHtml from 'sanitize-html';

/**
 * Email HTML sanitizer.
 *
 * Email is the most hostile HTML a browser ever renders: scripts, event handlers, forms that
 * phish, and remote images that tell the sender when (and from where) you opened the message.
 * Everything executable is stripped here on the server; remote images are blocked unless the
 * reader asks for them, and the result is still rendered in a sandboxed iframe as a second wall.
 */

export interface SanitizedHtml {
  html: string;
  /** Remote images that were removed; the UI offers "Load images" when > 0. */
  blockedImages: number;
}

const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'center', 'code', 'col', 'colgroup', 'dd', 'del',
  'div', 'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'li',
  'mark', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
];

export function sanitizeEmailHtml(html: string, opts: { allowRemoteImages?: boolean } = {}): SanitizedHtml {
  let blockedImages = 0;
  const clean = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'title'],
      font: ['color', 'face', 'size'],
      td: ['colspan', 'rowspan', 'align', 'valign', 'width', 'bgcolor'],
      th: ['colspan', 'rowspan', 'align', 'valign', 'width', 'bgcolor'],
      table: ['width', 'align', 'cellpadding', 'cellspacing', 'border', 'bgcolor'],
      '*': ['style', 'align', 'dir'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
    allowProtocolRelative: false,
    // Inline styles stay (email layout depends on them) but nothing that can fetch or execute.
    allowedStyles: {
      '*': {
        color: [/^[#a-z0-9(),.\s%]+$/i],
        'background-color': [/^[#a-z0-9(),.\s%]+$/i],
        'text-align': [/^(left|right|center|justify)$/],
        'font-size': [/^[\d.]+(px|em|rem|%|pt)$/],
        'font-weight': [/^(normal|bold|\d{3})$/],
        'font-style': [/^(normal|italic)$/],
        'text-decoration': [/^[a-z\s-]+$/],
        width: [/^[\d.]+(px|%|em)?$/],
        'max-width': [/^[\d.]+(px|%|em)?$/],
        height: [/^[\d.]+(px|%|em)?$/],
        padding: [/^[\d.\spxem%]+$/],
        margin: [/^[\d.\spxem%auto-]+$/],
        border: [/^[\w\s#().,%-]+$/],
        'line-height': [/^[\d.]+(px|em|%)?$/],
      },
    },
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
      }),
      // Counted before attribute filtering, which would otherwise silently drop the src.
      img: (tagName, attribs) => {
        if (!opts.allowRemoteImages && /^\s*(https?:)?\/\//i.test(attribs.src ?? '')) {
          blockedImages++;
          return { tagName: 'span', attribs: {} };
        }
        return { tagName, attribs };
      },
    },
  });
  return { html: clean, blockedImages };
}
