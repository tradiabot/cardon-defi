export interface Alert {
  title: string;
  message: string;
  priority: 2 | 3 | 4 | 5;
  tags: string[];
}

export const alert = (title: string, message: string, priority: Alert['priority'] = 3, tags: string[] = []): Alert => ({ title, message, priority, tags });

export async function sendAlerts(topic: string | undefined, alerts: Alert[], panelUrl: string): Promise<string[]> {
  if (!topic || !alerts.length) return [];
  const results = await Promise.allSettled(alerts.map(async a => {
    const res = await fetch('https://ntfy.sh/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic, title: `DEX Pilot · ${a.title}`, message: a.message, priority: a.priority, tags: a.tags, click: panelUrl }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
  }));
  return results.flatMap(r => (r.status === 'rejected' ? [`alerta: ${(r.reason as Error).message}`] : []));
}
