/**
 * Real network wiring for Upstox. Everything here touches the outside world,
 * which is exactly why it is isolated from the feed client: the client itself
 * is fully testable because these three functions are injected.
 *
 * ⚠️ UNVERIFIED AGAINST THE LIVE API. The development sandbox blocks
 * upstox.com, so the endpoint paths and response shapes below are written from
 * documentation, not from an observed response. Run `npm run feed:smoke`
 * locally; if the shape differs, this file is the only place to correct it.
 */

import { AuthError, type FeedSocket, type SocketHandlers } from './feed-client.ts';
import { redact, type UpstoxCredentials } from './credentials.ts';

export const API_BASE = 'https://api.upstox.com';
export const AUTHORIZE_PATH = '/v3/feed/market-data-feed/authorize';

/**
 * Exchanges the Analytics Token for an authorised wss endpoint.
 *
 * A 401/403 here means the token is expired or revoked. It is surfaced as
 * AuthError so the feed client re-authenticates rather than treating it as a
 * transport fault — and, critically, without hard-stopping the source.
 */
export async function authorizeV3(credentials: UpstoxCredentials): Promise<string> {
  const response = await fetch(`${API_BASE}${AUTHORIZE_PATH}`, {
    method: 'GET',
    headers: { ...credentials.authHeader(), Accept: 'application/json' },
    redirect: 'follow',
  });

  if (response.status === 401 || response.status === 403) {
    throw new AuthError(
      `Upstox rejected the Analytics Token (HTTP ${response.status}). ` +
        `It is likely expired or revoked — regenerate it from the Developer Apps page.`,
      response.status,
    );
  }
  if (!response.ok) {
    throw new Error(`authorize failed with HTTP ${response.status}`);
  }

  const body = (await response.json()) as {
    data?: { authorizedRedirectUri?: string; authorized_redirect_uri?: string };
  };
  const uri = body.data?.authorizedRedirectUri ?? body.data?.authorized_redirect_uri;
  if (typeof uri !== 'string' || uri === '') {
    throw new Error(
      'authorize response did not contain an authorized redirect URI — ' +
        'the response shape may have changed; see src/adapters/tier1/upstox/live.ts',
    );
  }
  return uri;
}

/** Socket factory over Node's global WebSocket. Binary frames only. */
export function createSocketFactory(): (url: string, handlers: SocketHandlers) => FeedSocket {
  return (url, handlers) => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', () => handlers.onOpen());

    socket.addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data;
      if (data instanceof ArrayBuffer) {
        handlers.onMessage(new Uint8Array(data));
      } else if (typeof data === 'string') {
        // V3 sends protobuf; a text frame is almost always an error envelope.
        handlers.onMessage(new TextEncoder().encode(data));
      }
    });

    socket.addEventListener('close', (event) => {
      const close = event as { code?: number; reason?: string };
      handlers.onClose(close.code ?? 1006, close.reason ?? '');
    });

    socket.addEventListener('error', () => {
      // The DOM error event carries no detail; the close event that follows
      // has the code, and reconnect is scheduled there.
      handlers.onError(new Error('websocket error'));
    });

    return {
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
    };
  };
}

/** REST fetcher for historical candles. Read-only endpoints only. */
export function createRestFetcher(): (
  path: string,
  credentials: UpstoxCredentials,
) => Promise<unknown> {
  return async (path, credentials) => {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'GET',
      headers: { ...credentials.authHeader(), Accept: 'application/json' },
    });

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Upstox rejected the Analytics Token on ${path} (HTTP ${response.status})`,
        response.status,
      );
    }
    if (!response.ok) {
      const detail = redact(await response.text().catch(() => ''), credentials).slice(0, 300);
      throw new Error(`GET ${path} failed with HTTP ${response.status}: ${detail}`);
    }
    return response.json();
  };
}
