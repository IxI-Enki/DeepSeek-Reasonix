// A GitHub App installation token, minted from the App's private key. Read-only on
// discussions in one repository: the token cannot write anywhere or see another repo.

export type TokenSource = () => Promise<string>;

const b64url = (bytes: Uint8Array | string) => {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let bin = "";
  for (const b of raw) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};

function pemBody(pem: string): Uint8Array {
  const base64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

const der = (tag: number, ...parts: Uint8Array[]) => {
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    body.set(p, at);
    at += p.length;
  }
  const len = body.length < 128 ? [body.length] : body.length < 256 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 0xff];
  return new Uint8Array([tag, ...len, ...body]);
};

// GitHub issues the key as a PKCS#1 "RSA PRIVATE KEY"; WebCrypto only imports
// PKCS#8, so a PKCS#1 key is wrapped in the PKCS#8 envelope (rsaEncryption, no parameters).
export function toPkcs8(pem: string): Uint8Array {
  const bytes = pemBody(pem);
  if (!/BEGIN RSA PRIVATE KEY/.test(pem)) return bytes;
  const rsaEncryption = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  return der(0x30, new Uint8Array([0x02, 0x01, 0x00]), der(0x30, rsaEncryption), der(0x04, bytes));
}

export async function appJwt(appId: string, privateKeyPem: string, nowSeconds: number): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", toPkcs8(privateKeyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claims}`)));
  return `${head}.${claims}.${b64url(signature)}`;
}

export interface AppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
  repository: string; // the one repository name the token is scoped to
}

// installationToken asks for the least the job needs: discussions, read, one repository.
export function installationToken(app: AppConfig, fetchFn: typeof fetch = fetch, now: () => number = () => Date.now()): TokenSource {
  return async () => {
    const jwt = await appJwt(app.appId, app.privateKey, Math.floor(now() / 1000));
    const res = await fetchFn(`https://api.github.com/app/installations/${encodeURIComponent(app.installationId)}/access_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "reasonix-forum-bridge", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
      body: JSON.stringify({ repositories: [app.repository], permissions: { discussions: "read" } }),
    });
    if (!res.ok) throw new Error(`installation token refused (${res.status})`);
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new Error("installation token response had no token");
    return body.token;
  };
}
