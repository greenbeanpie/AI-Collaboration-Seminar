export function projectReturnPath(value: string | null, projectId: string): string | null {
  if (!value || /[\\\r\n]/.test(value)) return null;
  const prefix = `/app/projects/${encodeURIComponent(projectId)}/`;
  try {
    const url = new URL(value, 'https://project.invalid');
    if (url.origin !== 'https://project.invalid' || !url.pathname.startsWith(prefix) || value.startsWith('//')) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}
