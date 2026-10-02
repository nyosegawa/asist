import { describe, expect, it } from 'vitest'
import { bodyPartsOf, htmlToPlain } from '../src/main/services/mail-body'

describe('reading a bodyStructure', () => {
  it('separates the text and html body parts from the attachments, and numbers a single part 1', () => {
    const single = bodyPartsOf({ type: 'text/plain', size: 3 })
    expect(single).toEqual({ parts: { textPart: '1', htmlPart: null }, attachments: [] })
    const mixed = bodyPartsOf({
      type: 'multipart/mixed',
      childNodes: [
        {
          type: 'multipart/alternative',
          childNodes: [
            { part: '1.1', type: 'text/plain', size: 10 },
            { part: '1.2', type: 'text/html', size: 20 }
          ]
        },
        { part: '2', type: 'application/pdf', size: 500, disposition: 'attachment', dispositionParameters: { filename: '資料.pdf' } },
        { part: '3', type: 'image/png', size: 40, parameters: { name: 'logo.png' }, disposition: 'inline' },
        { part: '4', type: 'text/plain', size: 8, disposition: 'attachment', dispositionParameters: { filename: 'notes.txt' } }
      ]
    })
    expect(mixed.parts).toEqual({ textPart: '1.1', htmlPart: '1.2' })
    expect(mixed.attachments).toEqual([
      { filename: '資料.pdf', contentType: 'application/pdf', size: 500 },
      { filename: 'logo.png', contentType: 'image/png', size: 40 },
      { filename: 'notes.txt', contentType: 'text/plain', size: 8 }
    ])
    expect(bodyPartsOf(undefined)).toEqual({ parts: { textPart: null, htmlPart: null }, attachments: [] })
  })

  it('turns HTML into plain text, dropping link targets, images and styles', () => {
    expect(htmlToPlain('<style>p{}</style><p>こんにちは <a href="https://x.example">サイト</a></p><img src="a.png"><script>x()</script>')).toBe('こんにちは サイト')
  })
})
