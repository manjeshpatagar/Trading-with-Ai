const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
export const token = () => typeof window === 'undefined' ? '' : localStorage.getItem('upstox_session') || '';
export const upstoxLoginUrl = () => `${base}/auth/upstox/login`;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(base + path, { ...init, headers: { Authorization: `Bearer ${token()}`, ...init?.headers } });
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw new Error('Cannot connect to the trading service. Please try again.');
  }
  if (!response.ok) {
    const body = await response.text();
    let message = `Request failed (${response.status}). Please try again.`;
    try {
      const error = JSON.parse(body);
      if (typeof error.message === 'string') message = error.message;
      else if (Array.isArray(error.message)) message = error.message.filter((item: unknown) => typeof item === 'string').join('. ') || message;
    } catch {
      if (body && !body.trim().startsWith('<')) message = body.slice(0, 300);
    }
    throw new Error(message);
  }
  const data = await response.json();
  if (typeof window !== 'undefined' && path.includes('/generate') && data?.success === false) {
    window.dispatchEvent(new CustomEvent('quantpulse-setup-monitoring', { detail: data }));
  }
  return data;
}
export { base };
