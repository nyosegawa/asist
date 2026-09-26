import { describe, expect, it } from 'vitest'
import { isExternalLink } from '@shared/external-link'

describe('isExternalLink', () => {
  it('takes a web page or a mail address, in any letter case', () => {
    for (const url of ['https://example.com/a?b=1#c', 'http://example.com', 'HTTPS://EXAMPLE.COM', 'mailto:team@example.com']) {
      expect(isExternalLink(url)).toBe(true)
    }
  })

  it('refuses a scheme that would open a local file or start another application, a place in a page, and a relative path', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'x-apple.systempreferences:com.apple.preference', 'asist-file:///r/a.png', '#_Toc1', 'report.pdf', '']) {
      expect(isExternalLink(url)).toBe(false)
    }
  })
})
