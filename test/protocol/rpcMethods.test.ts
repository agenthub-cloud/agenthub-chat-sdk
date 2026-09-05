import { describe, expect, it } from 'vitest'
import { RPC_METHODS } from '../../src/protocol/rpcMethods.js'

describe('rpcMethods', () => {
  it('15 个方法名与后端一致', () => {
    expect(Object.keys(RPC_METHODS)).toHaveLength(15)
    expect(RPC_METHODS).toMatchObject({ RUN_SUBSCRIBE: 'chat.run.subscribe', SESSION_CLIENT_DECLARE: 'chat.session.client.declare', TOOL_RESULT: 'chat.tool.result', PING: 'chat.ping' })
  })
})
