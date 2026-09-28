import { describe, expect, it } from 'vitest'
import { windowsPathFolders } from '../src/main/services/windows-search-path'

describe('the folders of a Windows PATH', () => {
  it('keeps absolute folders in order and drops empty and relative entries', () => {
    expect(windowsPathFolders('C:\\a;;.\\bin;tools;C:\\b\\;\\\\server\\share\\bin;')).toEqual(['C:\\a', 'C:\\b\\', '\\\\server\\share\\bin'])
  })

  it('drops the quotes around a folder', () => {
    expect(windowsPathFolders('"C:\\Program Files\\Git\\cmd";C:\\b')).toEqual(['C:\\Program Files\\Git\\cmd', 'C:\\b'])
  })

  it('does not split a quoted folder at the ; inside it', () => {
    expect(windowsPathFolders('C:\\a;"C:\\odd;name\\bin";C:\\b')).toEqual(['C:\\a', 'C:\\odd;name\\bin', 'C:\\b'])
  })

  it('leaves out a quoted folder that is relative', () => {
    expect(windowsPathFolders('"rel;ative";C:\\a')).toEqual(['C:\\a'])
  })
})
