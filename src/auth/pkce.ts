/**
 * OAuth 2.0 Authorization Code + PKCE (RFC 7636) helpers.
 *
 * Pure crypto/URL building — no HTTP client here. The caller supplies the
 * token endpoint exchange (or uses `exchangeCodeForToken` with a fetch
 * implementation). PKCE protects public clients (CLI/desktop) from auth-code
 * interception: the verifier is never sent until the token exchange.
 */
import { createHash, randomBytes } from 'node:crypto'

/** OAuth token response (subset of RFC 6749 §5.1). */
export interface OAuthTokenResponse {
  access_token: string
  token_type?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
}

export interface PkcePair {
  /** 43-128 char random verifier (sent only at token exchange). */
  verifier: string
  /** S256 challenge derived from the verifier (sent in the auth request). */
  challenge: string
  /** S256 challenge method — always 'S256'. */
  method: 'S256'
}

export interface AuthorizationRequest {
  /** Authorization endpoint URL. */
  authorizationEndpoint: string
  clientId: string
  redirectUri: string
  /** Space-separated scopes (optional). */
  scope?: string
  /** Optional state for CSRF protection (random when omitted). */
  state?: string
}

/** Generate a PKCE verifier (43 alphanumeric chars) + S256 challenge. */
export function createPkcePair(entropyBytes = 32): PkcePair {
  const verifier = base64Url(randomBytes(entropyBytes)).slice(0, 43)
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge, method: 'S256' }
}

/** Build the authorization URL (code + PKCE S256 + optional state). */
export function buildAuthorizationUrl(request: AuthorizationRequest, pkce: PkcePair): string {
  const url = new URL(request.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', request.clientId)
  url.searchParams.set('redirect_uri', request.redirectUri)
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', pkce.method)
  if (request.scope) url.searchParams.set('scope', request.scope)
  url.searchParams.set('state', request.state ?? randomState())
  return url.toString()
}

/** Verify the state returned by the IdP matches what we sent (CSRF guard). */
export function verifyState(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected || !actual) return false
  return timingSafeStr(expected, actual)
}

export interface TokenExchangeRequest {
  tokenEndpoint: string
  clientId: string
  redirectUri: string
  /** The authorization code from the redirect. */
  code: string
  /** The PKCE verifier generated alongside the challenge. */
  verifier: string
  /** Custom fetch (defaults to globalThis.fetch). */
  fetchImpl?: typeof fetch
}

/** Exchange the authorization code for tokens using the PKCE verifier. */
export async function exchangeCodeForToken(
  request: TokenExchangeRequest,
): Promise<OAuthTokenResponse> {
  const doFetch = request.fetchImpl ?? globalThis.fetch
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    code: request.code,
    code_verifier: request.verifier,
  })
  const response = await doFetch(request.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Token exchange failed (${response.status}): ${detail.slice(0, 300)}`)
  }
  const data = (await response.json()) as OAuthTokenResponse
  if (!data.access_token) throw new Error('Token exchange response missing access_token')
  return data
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function randomState(length = 16): string {
  return base64Url(randomBytes(length))
}

function timingSafeStr(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length)
  const bufA = Buffer.alloc(max)
  const bufB = Buffer.alloc(max)
  bufA.write(a)
  bufB.write(b)
  return a.length === b.length && createHash('sha256').update(bufA).digest().equals(createHash('sha256').update(bufB).digest())
}