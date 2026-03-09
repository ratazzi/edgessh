export interface SavedServer {
  name?: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  credential: string;
  passphrase?: string;
}

let cachedServers: SavedServer[] | null = null;

export async function loadServers(): Promise<SavedServer[]> {
  if (cachedServers !== null) return cachedServers;

  const res = await fetch("/api/servers");
  if (!res.ok) {
    cachedServers = [];
    return cachedServers;
  }

  const data = await res.json();
  cachedServers = (data.servers ?? []) as SavedServer[];
  return cachedServers;
}

export async function saveServers(servers: SavedServer[]): Promise<void> {
  const res = await fetch("/api/servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ servers }),
  });

  if (!res.ok) throw new Error("Failed to save servers");
  cachedServers = servers;
}
