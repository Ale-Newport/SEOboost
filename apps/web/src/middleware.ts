import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge-safe route protection.
 *
 * Only checks for the presence of a session cookie — the cryptographic and database validation
 * happens in `getCurrentUser()` on the Node runtime. This keeps the middleware fast and free of
 * Node-only dependencies while still bouncing anonymous visitors to the login page.
 */
const PUBLIC_PATHS = ['/login', '/signup', '/api/auth', '/api/health', '/api/integrations/google/callback'];

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const hasSession = request.cookies.has('seo_os_session');
  if (hasSession) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Authentication required', code: 'UNAUTHORIZED' }, { status: 401 });
  }

  const loginUrl = new URL('/login', request.url);
  if (pathname !== '/') loginUrl.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)'],
};
