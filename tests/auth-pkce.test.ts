import { describe, expect, it } from 'vitest'
import {
  buildAuthorizationUrl,
  createPkcePair,
  exchangeCodeForToken,
  verifyState,
  type OAuthTokenResponse,
} from '../src/auth/pkce.js'

describe('OAuth PKCE', () => {
  it('generates a verifier + S256 challenge pair', () => {
    const pair = createPkcePair()
    expect(pair.verifier).toHaveLength(43)
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(pair.method).toBe('S256')
    expect(pair.challenge.length).toBeGreaterThan(20)
  })

  it('verifier is not leaked into the authorization URL (only the challenge)', () => {
    const pair = createPkcePair()
    const url = buildAuthorizationUrl(
      { authorizationEndpoint: 'https://idp.example/auth', clientId: 'cli-app', redirectUri: 'http://localhost:9876/cb', scope: 'read write', state: 'st-1' },
      pair,
    )
    expect(url.startsWith('https://idp.example/auth')).toBe(true)
    expect(url).not.toContain(pair.verifier)
    expect(url).toContain(`code_challenge=${pair.challenge}`)
    expect(url).toContain('code_challenge_method=S256')
    expect(url).toContain('response_type=code')
    expect(url).toContain('client_id=cli-app')
    expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A9876%2Fcb')
    expect(url).toContain('state=st-1')
  })

  it('verifies state with timing-safe compare and rejects mismatches', () => {
    expect(verifyState('abc', 'abc')).toBe(true)
    expect(verifyState('abc', 'abd')).toBe(false)
    expect(verifyState(undefined, 'abc')).toBe(false)
    expect(verifyState('abc', undefined)).toBe(false)
  })

  it('exchanges an authorization code for tokens', async () => {
    const calls: Array<{ url: string; body: string }> = []
    const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, body: String(init.body) })
      return new Response(JSON.stringify({ access_token: 'tok-1', token_type: 'Bearer', expires_in: 3600 } satisfies OAuthTokenResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const data = await exchangeCodeForToken({
      tokenEndpoint: 'https://idp.example/token',
      clientId: 'cli-app',
      redirectUri: 'http://localhost:9876/cb',
      code: 'auth-code-1',
      verifier: 'v-123',
      fetchImpl: fakeFetch as typeof fetch,
    })
    expect(data.access_token).toBe('tok-1')
    expect(calls[0]?.url).toBe('https://idp.example/token')
    expect(calls[0]?.body).toContain('grant_type=authorization_code')
    expect(calls[0]?.body).toContain('code=auth-code-1')
    expect(calls[0]?.body).toContain('code_verifier=v-123')
  })

  it('throws when the token endpoint rejects', async () => {
    const fakeFetch = async (): Promise<Response> => {
      return new Response('invalid_grant', { status: 400 })
    }
    await expect(
      exchangeCodeForToken({
        tokenEndpoint: 'https://idp.example/token',
        clientId: 'cli-app',
        redirectUri: 'http://localhost:9876/cb',
        code: 'bad',
        verifier: 'v',
        fetchImpl: fakeFetch as typeof fetch,
      }),
    ).rejects.toThrow(/Token exchange failed \(400\)/)
  })

  it('throws when the response lacks access_token', async () => {
    const fakeFetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 200 })
    }
    await expect(
      exchangeCodeForToken({
        tokenEndpoint: 'https://idp.example/token',
        clientId: 'cli-app',
        redirectUri: 'http://localhost:9876/cb',
        code: 'x',
        verifier: 'v',
        fetchImpl: fakeFetch as typeof fetch,
      }),
    ).rejects.toThrow(/missing access_token/)
  })
})