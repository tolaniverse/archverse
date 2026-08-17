export function titleFromPrompt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (compact.length <= 64) return compact;
  return `${compact.slice(0, 61).trim()}…`;
}
