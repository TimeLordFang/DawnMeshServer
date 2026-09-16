# DawnMesh browser interfaces

TypeScript 7.0.2 (strict mode), Vite 8.3.0 and LiveKit 2.22.3. Both `/client/`
and `/admin/` share the same locally bundled SDK and E2EE worker. No CDN, web
font service or Node.js process is needed in production.

```sh
npm ci
npm run dev        # http://127.0.0.1:5173/ui/client/; proxies /api to Go :8080
npm run build      # typecheck + output to ../internal/server/web
npm test           # media key and microphone race regressions
npm run test:browser # local Chrome; CI uses Playwright Chromium
```

`src/client` contains the intercom, typed protocol state and native-compatible
SPAKE2/chat encryption. `src/admin` contains the administration interface.
`src/shared` contains the microphone gate, keyboard/pointer controls, media-key
encoding and shared design tokens. Generated `internal/server/web` files are
committed so plain `go build` remains supported; do not edit generated files.

Browser tests use real Chromium synthetic capture, with only LiveKit signalling
mocked. They cover permission delays/denial, muted publication, keyboard input,
window blur, cleanup, playback unlocking and mobile overflow. A live LiveKit
server and a physical microphone are still required for hardware/network and
native-device end-to-end acceptance.

Use `../scripts/build.sh` from the repository for a complete local package.
