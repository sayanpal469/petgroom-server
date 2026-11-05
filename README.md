# PetGroom Server

Backend API for PetGroom (Paws Station). Node 22+, Express, MongoDB.

## Run locally

```bash
cp .env.example .env   # fill in the values
npm install
npm run dev            # http://localhost:4000
```

`npm run dev:memory` runs against a throwaway, seeded database instead.

## Deploy on Hostinger (Node.js hosting)

- **Entry file:** `server.cjs`. **Start command:** `npm start`. (`src/server.js` also works on Node 22.12+.)
- Hostinger loads the entry with `require()` and expects `listen()` within 3 seconds. `server.cjs` loads the ES-module API with `import()`, and the server opens its port within a fraction of a second, before it loads Express and connects to MongoDB. Keep top-level `await` out of `src/`: `require()` refuses it. `test/startup.test.js` checks both.
- `.env` is not in git. Add these in the Hostinger panel as environment variables (or upload a `.env` file next to `package.json`; panel values win):
  - `NODE_ENV=production`
  - `MONGODB_URI`, `TUNNEL_SECRET`, `DATA_SECRET` (two different values, see `.env.example`)
  - `ALLOWED_ORIGINS`: the website and portal addresses, all `https://`, comma separated. The server won't start in production with `http://` here.
  - `TRUST_PROXY=1`
- `PORT` is set by Hostinger. Don't set it yourself.
- In MongoDB Atlas, allow the Hostinger server's IP under Network Access.

## Deploy on a VPS

`WEB_CONCURRENCY=4 npm run start:cluster` runs four workers, restarted if they crash. Without `WEB_CONCURRENCY` it runs one process, like `npm start`.

## Tests

`npm test` uses an in-memory MongoDB and never touches real data.
