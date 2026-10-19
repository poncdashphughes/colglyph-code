import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Self-signed dev certs (generated locally, not committed) let phones on
// the LAN reach the dev server over HTTPS — iOS refuses getUserMedia on
// plain HTTP, so camera testing needs this. Absent certs → plain HTTP.
const certDir = path.resolve(__dirname, '.dev-certs');
const devHttps = fs.existsSync(path.join(certDir, 'cert.pem'))
  ? {
      key: fs.readFileSync(path.join(certDir, 'key.pem')),
      cert: fs.readFileSync(path.join(certDir, 'cert.pem')),
    }
  : undefined;

export default defineConfig(({ command, mode }) => ({
  root: '.',
  publicDir: 'public',
  base: command === 'build' ? '/colglyph-code/' : '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
  server: {
    port: parseInt(process.env.PORT || '3001'),
    // `vite --mode http` forces plain HTTP even when dev certs exist
    https: mode === 'http' ? undefined : devHttps,
    // The dev server may be reachable on the LAN (phone camera testing)
    // — never serve local tooling or key material from it.
    fs: {
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.claude/**', '**/.dev-certs/**'],
    },
  },
}));
