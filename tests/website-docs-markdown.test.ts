import { describe, expect, it } from 'vitest'
import { docsMarkdown } from '../website/src/docs-markdown'

const page = (body: string): string => docsMarkdown({ title: 'Page', body })

describe('docsMarkdown', () => {
  it('keeps the text of an indented tab as text rather than an indented code block', () => {
    const markdown = page(
      [
        "import { Tabs, TabItem } from '@astrojs/starlight/components'",
        '',
        '<Tabs>',
        '  <TabItem label="codex">',
        '    Sign in first.',
        '',
        '    ```bash',
        '    codex login',
        '    ```',
        '  </TabItem>',
        '</Tabs>'
      ].join('\n')
    )
    expect(markdown).toBe('# Page\n\n**codex**\n\nSign in first.\n\n```bash\ncodex login\n```\n')
  })

  it('keeps tabs inside a list step at the indentation of the step', () => {
    const markdown = page(
      ['<Steps>', '', '1. **Make a password**', '', '   <Tabs>', '     <TabItem label="Gmail">', '       Open the page.', '     </TabItem>', '   </Tabs>', '', '</Steps>'].join('\n')
    )
    expect(markdown).toBe('# Page\n\n1. **Make a password**\n\n   **Gmail**\n\n   Open the page.\n')
  })

  it('turns an aside into a GitHub alert at its own indentation', () => {
    const markdown = page(['1. Step', '', '   <Aside type="caution">', '   Read this first.', '   </Aside>'].join('\n'))
    expect(markdown).toBe('# Page\n\n1. Step\n\n   > [!WARNING]\n   > Read this first.\n')
  })

  it('points links, images and link cards at the published site', () => {
    const markdown = page(
      ['See [setup](/docs/start/setup/) and ![home](/screens/ja/home.webp).', '<CardGrid>', '  <LinkCard title="Start" description="First steps" href="/docs/start/" />', '</CardGrid>'].join('\n')
    )
    expect(markdown).toContain('[setup](https://asist-agent.com/docs/start/setup/)')
    expect(markdown).toContain('![home](https://asist-agent.com/screens/ja/home.webp)')
    expect(markdown).toContain('- [Start](https://asist-agent.com/docs/start/): First steps')
  })

  it('leaves tags and site paths inside a code block alone', () => {
    const body = ['```mdx', '<Tabs syncKey="os">', '[a](/docs/)', '```'].join('\n')
    expect(page(body)).toBe(`# Page\n\n${body}\n`)
  })

  it('stops on a component it has no Markdown form for', () => {
    expect(() => page('<Badge text="New" />')).toThrow('<Badge>')
  })
})
