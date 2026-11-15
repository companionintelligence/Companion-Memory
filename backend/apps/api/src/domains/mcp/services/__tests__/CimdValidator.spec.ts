import { isValidCimdClientId, validateCimdDocument } from '../CimdValidator';

describe('CimdValidator (MCP Client ID Metadata Documents)', () => {
  const validClientId = 'https://agent.example.com/.well-known/oauth-client.json';

  describe('isValidCimdClientId', () => {
    it('accepts valid HTTPS public domain CIMD URLs with non-root path', () => {
      expect(isValidCimdClientId(validClientId)).toBe(true);
      expect(isValidCimdClientId('https://sub.example.org:8443/clients/mcp/metadata.json?v=1')).toBe(true);
    });

    it('rejects non-HTTPS schemes, credentials in userinfo, fragments, and bare origins', () => {
      expect(isValidCimdClientId('http://agent.example.com/client.json')).toBe(false);
      expect(isValidCimdClientId('ftp://agent.example.com/client.json')).toBe(false);
      expect(isValidCimdClientId('https://user:pass@agent.example.com/client.json')).toBe(false);
      expect(isValidCimdClientId('https://user@agent.example.com/client.json')).toBe(false);
      expect(isValidCimdClientId('https://agent.example.com/client.json#fragment')).toBe(false);
      expect(isValidCimdClientId('https://agent.example.com/')).toBe(false);
      expect(isValidCimdClientId('https://agent.example.com')).toBe(false);
      expect(isValidCimdClientId('not-a-url')).toBe(false);
    });

    it('rejects IPv4 literals, numeric/hex IPv4 aliases, and bracketed IPv6 loopback/LLA/mapped addresses', () => {
      expect(isValidCimdClientId('https://127.0.0.1/client.json')).toBe(false);
      expect(isValidCimdClientId('https://10.0.0.1/client.json')).toBe(false);
      expect(isValidCimdClientId('https://169.254.169.254/latest/meta-data')).toBe(false);
      expect(isValidCimdClientId('https://0x7f.1/client.json')).toBe(false);
      expect(isValidCimdClientId('https://[::1]/client.json')).toBe(false);
      expect(isValidCimdClientId('https://[fe80::1]/client.json')).toBe(false);
      expect(isValidCimdClientId('https://[::ffff:127.0.0.1]/client.json')).toBe(false);
    });

    it('rejects localhost, trailing-dot localhost, and private/internal domain suffixes', () => {
      expect(isValidCimdClientId('https://localhost/client.json')).toBe(false);
      expect(isValidCimdClientId('https://localhost./client.json')).toBe(false);
      expect(isValidCimdClientId('https://agent.localhost/client.json')).toBe(false);
      expect(isValidCimdClientId('https://agent.localhost./client.json')).toBe(false);
      expect(isValidCimdClientId('https://hub.local/client.json')).toBe(false);
      expect(isValidCimdClientId('https://service.internal/client.json')).toBe(false);
      expect(isValidCimdClientId('https://1.0.0.127.in-addr.arpa/client.json')).toBe(false);
    });
  });

  describe('validateCimdDocument', () => {
    it('accepts valid metadata documents with HTTPS, loopback HTTP, and native custom URI redirects', () => {
      const result = validateCimdDocument(validClientId, {
        client_id: validClientId,
        client_name: 'Example MCP Client',
        token_endpoint_auth_method: 'none',
        redirect_uris: [
          'https://agent.example.com/oauth/callback',
          'http://localhost:8080/callback',
          'http://127.0.0.1:5173/callback',
          'http://[::1]:5173/callback',
          'com.example.mcp:/oauth/callback',
        ],
      });

      expect(result.valid).toBe(true);
    });

    it('rejects executable/XSS redirect_uri schemes, URL fragments, and non-loopback plain HTTP redirects', () => {
      const dangerousUris = [
        'javascript:alert(1)',
        'JAVASCRIPT:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'vbscript:msgbox(1)',
        'file:///etc/passwd',
        'blob:https://agent.example.com/123',
        'about:blank',
        'ftp://agent.example.com/cb',
        'ws://agent.example.com/cb',
        'https://agent.example.com/cb#token',
        'http://agent.example.com/cb',
      ];

      for (const redirectUri of dangerousUris) {
        const res = validateCimdDocument(validClientId, {
          client_id: validClientId,
          client_name: 'Bad Client',
          redirect_uris: [redirectUri],
        });
        expect(res.valid).toBe(false);
      }
    });

    it('rejects symmetric client_secret token endpoint auth methods', () => {
      for (const method of ['client_secret_basic', 'client_secret_post', 'client_secret_jwt']) {
        const res = validateCimdDocument(validClientId, {
          client_id: validClientId,
          client_name: 'Symmetric Client',
          token_endpoint_auth_method: method,
          redirect_uris: ['https://agent.example.com/callback'],
        });
        expect(res).toEqual({
          valid: false,
          reason: 'CIMD clients must not declare symmetric client_secret auth methods',
        });
      }
    });

    it('rejects malformed documents, client_id mismatch, missing client_name, and invalid redirect_uris types', () => {
      expect(validateCimdDocument('http://invalid.example.com/a.json', {}).valid).toBe(false);
      expect(validateCimdDocument(validClientId, null).valid).toBe(false);
      expect(
        validateCimdDocument(validClientId, {
          client_id: 'https://other.example.com/client.json',
          client_name: 'Mismatch',
          redirect_uris: ['https://other.example.com/cb'],
        }).valid,
      ).toBe(false);
      expect(
        validateCimdDocument(validClientId, {
          client_id: validClientId,
          redirect_uris: ['https://agent.example.com/cb'],
        }).valid,
      ).toBe(false);
      expect(
        validateCimdDocument(validClientId, {
          client_id: validClientId,
          client_name: 'No Redirects',
          redirect_uris: [],
        }).valid,
      ).toBe(false);
      expect(
        validateCimdDocument(validClientId, {
          client_id: validClientId,
          client_name: 'Non-string Redirect',
          redirect_uris: [123],
        }).valid,
      ).toBe(false);
    });
  });
});
