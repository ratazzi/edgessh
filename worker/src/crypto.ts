const encoder = new TextEncoder();

async function deriveKey(masterKey: string, userId: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterKey),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(userId),
      info: encoder.encode("zerossh-server-encryption"),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encrypt(plaintext: string, masterKey: string, userId: string): Promise<string> {
  const key = await deriveKey(masterKey, userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );

  // Store as JSON: { iv: base64, ciphertext: base64 }
  return JSON.stringify({
    iv: uint8ArrayToBase64(iv),
    ciphertext: uint8ArrayToBase64(new Uint8Array(ciphertext)),
  });
}

export async function decrypt(encrypted: string, masterKey: string, userId: string): Promise<string> {
  const key = await deriveKey(masterKey, userId);
  const { iv, ciphertext } = JSON.parse(encrypted) as { iv: string; ciphertext: string };

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToUint8Array(iv) as unknown as ArrayBuffer },
    key,
    base64ToUint8Array(ciphertext) as unknown as ArrayBuffer,
  );

  return new TextDecoder().decode(decrypted);
}

function uint8ArrayToBase64(arr: Uint8Array): string {
  let binary = "";
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToUint8Array(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
