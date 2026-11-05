// No sign-in for now. The extension goes by hand to a few people who asked through the request
// form on the site, so who gets it is controlled there. WorkOS sign-in (in git history) comes back
// before the store submission.
//
// Each install makes a random id (extension/install-id.js) and sends it as `X-Synergy-User`, which
// keeps one person's profile, leads and notes apart from another's. It is not authentication:
// anyone holding an id can act as it. 'unclaimed' (rows from before sign-in) can't match.
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The user for an API request: { userId } or { error, message, status }. */
export function identify(request) {
  const id = request.headers.get('X-Synergy-User')?.trim().toLowerCase();
  if (id && INSTALL_ID.test(id)) return { userId: `install_${id}` };
  return { error: 'install_id_required', message: 'Send this install\'s id as X-Synergy-User.', status: 400 };
}
