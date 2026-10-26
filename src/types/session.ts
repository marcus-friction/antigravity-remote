export interface PersistedCookieRecord {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: string;
  secure?: boolean;
  httpOnly?: boolean;
  originUrl: string;
}

export interface CookieVaultMetadata {
  version: 1 | 2 | 3;
  slot?: 'a' | 'b';
  chunkCount: number;
  updatedAtIso: string;
  cookieCount: number;
}

export type AuthFlowStage =
  | 'hydrating'
  | 'authenticating'
  | 'authenticated'
  | 'offline';

export interface UrlValidationResult {
  isValid: boolean;
  normalizedUrl: string | null;
  isAllowedInApp: boolean;
  isAuthHost: boolean;
  reason?: string;
}
