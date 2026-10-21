export const helpFiles: Readonly<{ user: 'USER-GUIDE.md'; technical: 'TECHNICAL-IMPLEMENTATION.md'; database: 'DATABASE-SCHEMA.md' }>;
export function handbookSection(source: string, key: keyof typeof helpFiles): string;
