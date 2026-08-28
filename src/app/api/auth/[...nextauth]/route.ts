import { handlers } from '@/lib/auth';

export const { GET, POST } = handlers;

// Auth must never be served from a cache.
export const dynamic = 'force-dynamic';
