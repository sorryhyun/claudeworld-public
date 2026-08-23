import { describe, expect, test } from 'bun:test'

import { parseSlashCommand } from '@/domain/slash-commands'

describe('parseSlashCommand', () => {
  test('recognises /chat and /end', () => {
    expect(parseSlashCommand('/chat')).toEqual({ commandType: 'chat', args: null })
    expect(parseSlashCommand('/end')).toEqual({ commandType: 'end', args: null })
  })

  test('is case-insensitive', () => {
    expect(parseSlashCommand('/CHAT').commandType).toBe('chat')
    expect(parseSlashCommand('/Chat').commandType).toBe('chat')
    expect(parseSlashCommand('/End').commandType).toBe('end')
  })

  test('trims surrounding whitespace, including newlines', () => {
    expect(parseSlashCommand('  /chat  ').commandType).toBe('chat')
    expect(parseSlashCommand('\n/end\t').commandType).toBe('end')
    expect(parseSlashCommand('  /CHAT\n').commandType).toBe('chat')
  })

  test('matching is exact, not a prefix', () => {
    // The bug this guards: "/chatter with the innkeeper" is an action, and a
    // startsWith test would swallow it into chat mode.
    expect(parseSlashCommand('/chatter').commandType).toBe('none')
    expect(parseSlashCommand('/chat with the innkeeper').commandType).toBe('none')
    expect(parseSlashCommand('/ending').commandType).toBe('none')
    expect(parseSlashCommand('/end the conversation').commandType).toBe('none')
  })

  test('interior whitespace is not stripped', () => {
    expect(parseSlashCommand('/ chat').commandType).toBe('none')
    expect(parseSlashCommand('/chat/end').commandType).toBe('none')
  })

  test('ordinary actions and unknown commands are none', () => {
    expect(parseSlashCommand('hello world')).toEqual({ commandType: 'none', args: null })
    expect(parseSlashCommand('chat').commandType).toBe('none')
    expect(parseSlashCommand('/quit').commandType).toBe('none')
    expect(parseSlashCommand('').commandType).toBe('none')
    expect(parseSlashCommand('   ').commandType).toBe('none')
  })
})
