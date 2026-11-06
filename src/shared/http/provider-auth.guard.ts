import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";

/**
 * Extension point for provider authentication.
 *
 * Currently allows every request (see ARCHITECTURE.md). Planned design:
 * validate an OIDC access token issued by an external Identity Provider
 * (e.g. Keycloak), verify its signature against the IdP's public keys (JWKS),
 * and ensure the providerId in the token matches the providerId in the payload.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}