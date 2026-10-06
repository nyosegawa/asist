import { describe, expect, it } from 'vitest'
import { parseSpeechDevices } from '@shared/speech-devices'

/** What `speech devices --json` printed on the RTX 2080 test machine, written as speech.cpp's README gives it. */
const RTX_2080 = '{"devices":[{"name":"Vulkan0","description":"NVIDIA GeForce RTX 2080","kind":"gpu","memory_total":8589934592,"memory_free":7516192768},{"name":"CPU","description":"Intel(R) Core(TM) i9-9900K CPU @ 3.60GHz","kind":"cpu","memory_total":34359738368,"memory_free":34359738368}]}\r\n'

describe('the device list of speech', () => {
  it('reads each device with its kind and memory', () => {
    expect(parseSpeechDevices(RTX_2080)).toEqual([
      { name: 'Vulkan0', description: 'NVIDIA GeForce RTX 2080', kind: 'gpu', memoryTotal: 8589934592 },
      { name: 'CPU', description: 'Intel(R) Core(TM) i9-9900K CPU @ 3.60GHz', kind: 'cpu', memoryTotal: 34359738368 }
    ])
  })

  it.each([
    ['nothing', ''],
    ['output that is not JSON', '{"devices":['],
    ['another object', '{"type":"fatal","error":{"code":"device","option":null,"message":"x"}}'],
    ['a device of a kind it does not know', '{"devices":[{"name":"X","description":"X","kind":"npu","memory_total":1}]}'],
    ['a device without its memory', '{"devices":[{"name":"X","description":"X","kind":"gpu"}]}']
  ])('reads nothing from %s, rather than a list that would decide the wrong GPU', (_case, output) => {
    expect(parseSpeechDevices(output)).toBeNull()
  })
})
