/** Internal helper — not exported from the barrel. */
export function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing ${name} — copy .env.example to .env and fill it in.`);
  }
  return value;
}
