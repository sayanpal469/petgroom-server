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

- **Entry file:** `src/server.js`. **Start command:** `npm start`.
- The server opens its port within a fraction of a second and connects to MongoDB afterwards, so it passes Hostinger's 3-second `listen()` check.
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
