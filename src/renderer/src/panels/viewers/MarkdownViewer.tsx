import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Frame } from './Frame'
import type { Viewer } from './types'
import { useT } from '@/i18n'

/**
 * Markdown drawn as a document. GFM (tables, task lists, strikethrough, autolinks) is understood and raw HTML
 * is not passed through. Links open in the browser. An image given by a relative path shows only its alt
 * text, because a reference relative to the file is not resolved. A notebook's markdown cells use this same
 * MarkdownContent.
 */
export function MarkdownContent({ text }: { text: string }): React.JSX.Element {
  const t = useT()
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault()
              if (href && /^https?:\/\//.test(href)) void window.api.openExternal(href)
            }}
          >
            {children}
          </a>
        ),
        img: ({ src, alt }) =>
          typeof src === 'string' && /^(https?:|data:|asist-file:)/.test(src) ? (
            <img src={src} alt={alt ?? ''} />
          ) : (
            <span>[{alt || t('files.viewer.image')}]</span>
          )
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

export const MarkdownViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  return (
    <Frame mode={mode} size={size}>
      <div className="fv-doc">
        <MarkdownContent text={item.text ?? ''} />
        {item.truncated && <p className="fv-note">{t('files.viewer.truncatedMarkdown')}</p>}
      </div>
    </Frame>
  )
}
